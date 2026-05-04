/**
 * Bridge — message orchestrator for the Feishu-Claude bridge.
 *
 * Consumes inbound messages from FeishuClient, routes slash commands,
 * handles card action callbacks, and dispatches to the conversation engine.
 * Uses per-session locks for concurrency control.
 */

import type {
  AppContext,
  InboundMessage,
  ChannelBinding,
  CliSessionInfo,
} from './types.js';
import * as conversation from './conversation.js';
import { deliver } from './delivery.js';
import {
  forwardPermissionRequest,
  handlePermissionCallback,
} from './permissions.js';
import {
  validateWorkingDirectory,
  isDangerousInput,
  sanitizeInput,
  validateMode,
} from './validators.js';
import { buildDirSelectCard, buildContinueSelectCard } from './feishu-markdown.js';

/** Extract unique working directories from recent CLI sessions, deduplicated. */
function getRecentDirs(ctx: AppContext): string[] {
  const sessions = ctx.store.listCliSessions({ limit: 50 });
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const s of sessions) {
    if (s.cwd && !seen.has(s.cwd)) {
      seen.add(s.cwd);
      dirs.push(s.cwd);
    }
  }
  return dirs.slice(0, 5);
}

// ── Session locks ────────────────────────────────────────────

const sessionLocks = new Map<string, Promise<void>>();

function processWithSessionLock(sessionId: string, fn: () => Promise<void>): Promise<void> {
  const prev = sessionLocks.get(sessionId) || Promise.resolve();
  const current = prev.then(fn, fn);
  sessionLocks.set(sessionId, current);
  current.finally(() => {
    if (sessionLocks.get(sessionId) === current) {
      sessionLocks.delete(sessionId);
    }
  }).catch(() => {});
  return current;
}

// ── Active tasks ─────────────────────────────────────────────

const activeTasks = new Map<string, AbortController>();

// ── Resolve binding ──────────────────────────────────────────

function resolveBinding(ctx: AppContext, chatId: string): ChannelBinding {
  const existing = ctx.store.getChannelBinding(chatId);
  if (existing) {
    const session = ctx.store.getSession(existing.codepilotSessionId);
    if (session) return existing;
  }
  return createNewBinding(ctx, chatId);
}

function createNewBinding(ctx: AppContext, chatId: string, workDir?: string): ChannelBinding {
  const cwd = workDir || ctx.config.defaultWorkDir || process.env.HOME || '';
  const model = ctx.config.defaultModel || '';
  const session = ctx.store.createSession(`Bridge: ${chatId}`, model, undefined, cwd);
  return ctx.store.upsertChannelBinding({
    chatId,
    codepilotSessionId: session.id,
    workingDirectory: cwd,
    model,
  });
}

// ── SDK Session Update Logic ─────────────────────────────────

function computeSdkSessionUpdate(
  sdkSessionId: string | null | undefined,
  hasError: boolean,
): string | null {
  if (sdkSessionId && !hasError) return sdkSessionId;
  if (hasError) return '';
  return null;
}

// ── CLI Session Helpers ──────────────────────────────────────

function resumeCliSession(ctx: AppContext, chatId: string, target: CliSessionInfo): string {
  const model = ctx.config.defaultModel || '';
  const session = ctx.store.createSession(
    `Resume: ${target.slug || target.sdkSessionId.slice(0, 8)}`,
    model,
    undefined,
    target.cwd,
  );

  const binding = ctx.store.upsertChannelBinding({
    chatId,
    codepilotSessionId: session.id,
    workingDirectory: target.cwd,
    model,
  });

  ctx.store.updateChannelBinding(binding.id, { sdkSessionId: target.sdkSessionId });

  const icon = target.isOpen ? '🟢' : '⚪';
  const prompt = target.firstPrompt.length > 40 ? target.firstPrompt.slice(0, 40) + '...' : target.firstPrompt;
  return [
    `${icon} 已恢复 CLI 会话`,
    '',
    `Project: \`${target.project}\``,
    `CWD: \`${target.cwd}\``,
    target.slug ? `Slug: \`${target.slug}\`` : '',
    `"${prompt}"`,
    '',
    `终端恢复: \`claude --resume ${target.sdkSessionId}\``,
    '',
    '现在可以直接发消息继续对话。',
  ].filter(Boolean).join('\n');
}

// ── Main loop ────────────────────────────────────────────────

export async function runBridgeLoop(ctx: AppContext): Promise<void> {
  while (ctx.feishu.isRunning()) {
    try {
      const msg = await ctx.feishu.consumeOne();
      if (!msg) continue;

      if (
        msg.callbackData ||
        msg.text.trim().startsWith('/')
      ) {
        await handleMessage(ctx, msg);
      } else {
        const binding = resolveBinding(ctx, msg.chatId);
        processWithSessionLock(binding.codepilotSessionId, () =>
          handleMessage(ctx, msg),
        ).catch(err => {
          console.error(`[bridge] Session ${binding.codepilotSessionId.slice(0, 8)} error:`, err);
        });
      }
    } catch (err) {
      console.error('[bridge] Error in loop:', err);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

// ── Message handler ──────────────────────────────────────────

async function handleMessage(ctx: AppContext, msg: InboundMessage): Promise<void> {
  // Handle callback queries (card action buttons)
  if (msg.callbackData) {
    // /new directory selection button
    if (msg.callbackData.startsWith('newdir:')) {
      const idx = parseInt(msg.callbackData.split(':')[1], 10);
      await handleNewDirCallback(ctx, msg.chatId, idx, msg.callbackMessageId);
      return;
    }
    // /continue session selection button
    if (msg.callbackData.startsWith('continue:')) {
      const idx = parseInt(msg.callbackData.split(':')[1], 10);
      await handleContinueCallback(ctx, msg.chatId, idx, msg.callbackMessageId);
      return;
    }
    // Permission button
    const handled = await handlePermissionCallback(ctx, msg.callbackData, msg.chatId, msg.callbackMessageId);
    return;
  }

  const rawText = msg.text.trim();
  const hasAttachments = msg.attachments && msg.attachments.length > 0;

  if (!rawText && !hasAttachments) return;

  // Slash commands
  if (rawText.startsWith('/')) {
    await handleCommand(ctx, msg, rawText);
    return;
  }

  // Sanitize
  const { text, truncated } = sanitizeInput(rawText);
  if (truncated) {
    console.warn(`[bridge] Input truncated from ${rawText.length} to ${text.length} chars`);
  }

  if (!text && !hasAttachments) return;

  // Regular message → conversation engine
  const binding = resolveBinding(ctx, msg.chatId);

  ctx.feishu.onMessageStart(msg.chatId);

  const taskAbort = new AbortController();
  activeTasks.set(binding.codepilotSessionId, taskAbort);

  // Tool call tracker for streaming card
  let currentCycleText = '';

  const onPartialText = (fullText: string) => {
    currentCycleText = fullText;
    try { ctx.feishu.onStreamText(msg.chatId, fullText); } catch { /* non-critical */ }
  };

  const onToolEvent = (toolId: string, toolName: string, status: 'running' | 'complete' | 'error', input?: Record<string, unknown>, error?: string) => {
    try {
      ctx.feishu.onToolEvent(msg.chatId, toolId, toolName, status, input, error);
    } catch { /* non-critical */ }
  };

  const onCycleComplete = () => {
    try { ctx.feishu.onCycleComplete(msg.chatId); } catch { /* non-critical */ }
  };

  try {
    const promptText = text || (hasAttachments ? 'Describe this image.' : '');

    const result = await conversation.processMessage(
      ctx,
      binding,
      promptText,
      async (perm) => {
        await forwardPermissionRequest(
          ctx,
          msg.chatId,
          perm.permissionRequestId,
          perm.toolName,
          perm.toolInput,
          binding.codepilotSessionId,
          perm.suggestions,
          msg.messageId,
          perm.title,
          perm.displayName,
          perm.description,
          perm.decisionReason,
        );
      },
      taskAbort.signal,
      hasAttachments ? msg.attachments : undefined,
      onPartialText,
      onToolEvent,
      onCycleComplete,
    );

    // Finalize streaming card
    let cardFinalized = false;
    try {
      const status = result.hasError ? 'error' : 'completed';
      cardFinalized = await ctx.feishu.onStreamEnd(msg.chatId, status, currentCycleText || result.responseText, result.tokenUsage);
      console.log(`[bridge] onStreamEnd: cardFinalized=${cardFinalized}, textLen=${(currentCycleText || result.responseText).length}`);
    } catch (err) {
      console.warn('[bridge] Card finalize failed:', err instanceof Error ? err.message : err);
    }

    // Send response text (skip if card was finalized or permission card already displayed content)
    const permResolved = ctx.feishu.consumePermissionResolved(msg.chatId);
    if (result.responseText) {
      if (!cardFinalized && !permResolved) {
        console.log(`[bridge] Delivering response text: ${result.responseText.length} chars (no card, no perm resolved)`);
        await deliver(ctx, msg.chatId, result.responseText, {
          sessionId: binding.codepilotSessionId,
          parseMode: 'Markdown',
          replyToMessageId: msg.messageId,
        });
      } else {
        console.log(`[bridge] Skipping deliver: cardFinalized=${cardFinalized}, permResolved=${permResolved}`);
      }
    } else if (result.hasError) {
      const errorText = `**Error:** ${result.errorMessage}`;
      await deliver(ctx, msg.chatId, errorText, {
        sessionId: binding.codepilotSessionId,
        parseMode: 'Markdown',
        replyToMessageId: msg.messageId,
      });
    }

    // Persist SDK session ID
    if (binding.id) {
      try {
        const update = computeSdkSessionUpdate(result.sdkSessionId, result.hasError);
        if (update !== null) {
          ctx.store.updateChannelBinding(binding.id, { sdkSessionId: update });
        }
      } catch { /* best effort */ }
    }
  } finally {
    if (taskAbort.signal.aborted) {
      try {
        await ctx.feishu.onStreamEnd(msg.chatId, 'interrupted', '');
      } catch { /* best effort */ }
    }
    activeTasks.delete(binding.codepilotSessionId);
    ctx.feishu.onMessageEnd(msg.chatId);
  }
}

// ── Card action callback handlers ──────────────────────────────

async function handleNewDirCallback(
  ctx: AppContext,
  chatId: string,
  idx: number,
  _callbackMessageId?: string,
): Promise<void> {
  const dirs = getRecentDirs(ctx);
  if (idx < 0 || idx >= dirs.length) {
    await deliver(ctx, chatId, '选择已过期，请重新发送 /new');
    return;
  }

  // Abort existing session
  const oldBinding = resolveBinding(ctx, chatId);
  const oldTask = activeTasks.get(oldBinding.codepilotSessionId);
  if (oldTask) {
    oldTask.abort();
    activeTasks.delete(oldBinding.codepilotSessionId);
  }

  const workDir = dirs[idx];
  const binding = createNewBinding(ctx, chatId, workDir);
  await deliver(ctx, chatId, [
    'New session created.',
    `Session: \`${binding.codepilotSessionId.slice(0, 8)}...\``,
    `CWD: \`${binding.workingDirectory}\``,
  ].join('\n'));
}

async function handleContinueCallback(
  ctx: AppContext,
  chatId: string,
  idx: number,
  _callbackMessageId?: string,
): Promise<void> {
  const sessions = ctx.store.listCliSessions({ limit: 5 });
  if (idx < 0 || idx >= sessions.length) {
    await deliver(ctx, chatId, '选择已过期，请重新发送 /continue');
    return;
  }

  const target = sessions[idx];

  // Abort running task
  const oldBinding = resolveBinding(ctx, chatId);
  const oldTask = activeTasks.get(oldBinding.codepilotSessionId);
  if (oldTask) {
    oldTask.abort();
    activeTasks.delete(oldBinding.codepilotSessionId);
  }

  const response = resumeCliSession(ctx, chatId, target);
  await deliver(ctx, chatId, response);
}

// ── Slash commands ───────────────────────────────────────────

async function handleCommand(
  ctx: AppContext,
  msg: InboundMessage,
  text: string,
): Promise<void> {
  const parts = text.split(/\s+/);
  const command = parts[0].split('@')[0].toLowerCase();
  const args = parts.slice(1).join(' ').trim();

  // Dangerous input check
  const dangerCheck = isDangerousInput(text);
  if (dangerCheck.dangerous) {
    console.warn(`[bridge] Blocked dangerous input: ${dangerCheck.reason}`);
    await deliver(ctx, msg.chatId, 'Command rejected: invalid input detected.');
    return;
  }

  let response = '';

  switch (command) {
    case '/start':
    case '/help':
      response = [
        '**Feishu-Claude Bridge**',
        '',
        'Send any message to interact with Claude.',
        '',
        '**Commands:**',
        '/new [path] - Start new session (no args to pick dir)',
        '/continue - Resume a recent session',
        '/mode plan|code|ask - Change mode',
        '/status - Show current status',
        '/stop - Stop current session',
        '/perm allow|allow_session|deny <id> - Permission response',
        '/help - Show this help',
      ].join('\n');
      break;

    case '/new': {
      if (!args) {
        // No args: show directory selection card
        const dirs = getRecentDirs(ctx);
        if (dirs.length === 0) {
          // No recent dirs, just create with default
          const binding = createNewBinding(ctx, msg.chatId);
          response = [
            'New session created.',
            `Session: \`${binding.codepilotSessionId.slice(0, 8)}...\``,
            `CWD: \`${binding.workingDirectory || '~'}\``,
          ].join('\n');
        } else {
          const cardJson = buildDirSelectCard(dirs, msg.chatId);
          await ctx.feishu.sendInteractiveCard(msg.chatId, cardJson, msg.messageId);
          return; // card sent, skip text response
        }
        break;
      }

      // Path argument provided
      const validated = validateWorkingDirectory(args);
      if (!validated) {
        response = 'Invalid path. Must be an absolute path without traversal sequences.';
        break;
      }

      // Abort existing session
      const oldBinding = resolveBinding(ctx, msg.chatId);
      const oldTask = activeTasks.get(oldBinding.codepilotSessionId);
      if (oldTask) {
        oldTask.abort();
        activeTasks.delete(oldBinding.codepilotSessionId);
      }

      const binding = createNewBinding(ctx, msg.chatId, validated);
      response = [
        'New session created.',
        `Session: \`${binding.codepilotSessionId.slice(0, 8)}...\``,
        `CWD: \`${binding.workingDirectory}\``,
      ].join('\n');
      break;
    }

    case '/mode': {
      if (!validateMode(args)) {
        response = 'Usage: /mode plan|code|ask';
        break;
      }
      const binding = resolveBinding(ctx, msg.chatId);
      ctx.store.updateChannelBinding(binding.id, { mode: args as 'code' | 'plan' | 'ask' });
      response = `Mode set to **${args}**`;
      break;
    }

    case '/status': {
      const binding = resolveBinding(ctx, msg.chatId);
      const lines = [
        '**Bridge Status**',
        '',
        `CWD: \`${binding.workingDirectory || '~'}\``,
        `Mode: **${binding.mode}**`,
        `Model: \`${binding.model || 'default'}\``,
      ];
      if (binding.sdkSessionId) {
        lines.push('', `SDK Session (用于终端 \`claude --resume\`):`);
        lines.push(`\`${binding.sdkSessionId}\``);
      } else {
        lines.push('', 'SDK Session: 尚未建立（发一条消息后生成）');
      }
      response = lines.join('\n');
      break;
    }

    case '/stop': {
      const binding = resolveBinding(ctx, msg.chatId);
      const taskAbort = activeTasks.get(binding.codepilotSessionId);
      if (taskAbort) {
        taskAbort.abort();
        activeTasks.delete(binding.codepilotSessionId);
        response = 'Stopping current task...';
      } else {
        response = 'No task is currently running.';
      }
      break;
    }

    case '/perm': {
      const permParts = args.split(/\s+/);
      const permAction = permParts[0];
      const permId = permParts.slice(1).join(' ');
      if (!permAction || !permId || !['allow', 'allow_session', 'deny'].includes(permAction)) {
        response = 'Usage: /perm allow|allow_session|deny <permission_id>';
        break;
      }
      const callbackData = `perm:${permAction}:${permId}`;
      const handled = await handlePermissionCallback(ctx, callbackData, msg.chatId);
      response = handled
        ? `Permission ${permAction}: recorded.`
        : 'Permission not found or already resolved.';
      break;
    }

    case '/continue': {
      const sessions = ctx.store.listCliSessions({ limit: 5 });
      if (sessions.length === 0) {
        response = 'No recent sessions found.';
        break;
      }
      const cardJson = buildContinueSelectCard(sessions, msg.chatId);
      await ctx.feishu.sendInteractiveCard(msg.chatId, cardJson, msg.messageId);
      return; // card sent, skip text response
    }

    default:
      response = `Unknown command: ${command}\nType /help for available commands.`;
  }

  if (response) {
    await deliver(ctx, msg.chatId, response, {
      parseMode: 'Markdown',
      replyToMessageId: msg.messageId,
    });
  }
}
