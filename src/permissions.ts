/**
 * Pending Permissions — Promise-based gateway for tool permission requests.
 *
 * waitFor() returns a promise that resolves when the IM user allows/denies.
 * No timeout — waits indefinitely until user responds. denyAll() for graceful shutdown.
 *
 * Also contains permission forwarding and callback handling logic
 * (merged from permission-broker.ts + permission-gateway.ts).
 */

import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionResult, AppContext } from './types.js';
import {
  buildPermissionButtonCard,
} from './feishu-markdown.js';

// ── Multi-question answer tracking ────────────────────────────

/** In-memory tracking of answers for multi-question AskUserQuestion. */
const multiQuestionAnswers = new Map<string, Map<number, number>>(); // permId → (qIdx → oIdx)

export function classifyQuestionMode(input: Record<string, unknown>): 'none' | 'single' | 'multi' {
  const questions = Array.isArray(input.questions) ? input.questions as Question[] : [];
  if (questions.length === 0) return 'none';
  if (questions.length === 1) return 'single';
  return 'multi';
}

export function setMultiQuestionAnswer(permissionRequestId: string, questionIndex: number, optionIndex: number): void {
  let answers = multiQuestionAnswers.get(permissionRequestId);
  if (!answers) {
    answers = new Map();
    multiQuestionAnswers.set(permissionRequestId, answers);
  }
  answers.set(questionIndex, optionIndex);
}

export function getMultiQuestionAnswers(permissionRequestId: string): Map<number, number> | undefined {
  return multiQuestionAnswers.get(permissionRequestId);
}

export function clearMultiQuestionAnswers(permissionRequestId: string): void {
  multiQuestionAnswers.delete(permissionRequestId);
}

export class PendingPermissions {
  private pending = new Map<string, {
    resolve: (r: PermissionResult) => void;
  }>();

  waitFor(toolUseID: string): Promise<PermissionResult> {
    return new Promise((resolve) => {
      this.pending.set(toolUseID, { resolve });
    });
  }

  resolve(permissionRequestId: string, resolution: { behavior: 'allow' | 'deny'; message?: string; updatedPermissions?: unknown[]; updatedInput?: Record<string, unknown> }): boolean {
    const entry = this.pending.get(permissionRequestId);
    if (!entry) return false;
    if (resolution.behavior === 'allow') {
      entry.resolve({
        behavior: 'allow',
        ...(resolution.updatedPermissions ? { updatedPermissions: resolution.updatedPermissions } : {}),
        ...(resolution.updatedInput ? { updatedInput: resolution.updatedInput } : {}),
      });
    } else {
      entry.resolve({ behavior: 'deny', message: resolution.message || 'Denied by user' });
    }
    this.pending.delete(permissionRequestId);
    return true;
  }

  denyAll(): void {
    for (const [, entry] of this.pending) {
      entry.resolve({ behavior: 'deny', message: 'Bridge shutting down' });
    }
    this.pending.clear();
  }

  get size(): number {
    return this.pending.size;
  }
}

// ── Permission forwarding ────────────────────────────────────

/** Dedup recent permission forwards. Key: permissionRequestId, value: timestamp. */
const recentPermissionForwards = new Map<string, number>();

/**
 * Forward a permission request to Feishu as an interactive card.
 */
export async function forwardPermissionRequest(
  ctx: AppContext,
  chatId: string,
  permissionRequestId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  sessionId?: string,
  suggestions?: unknown[],
  replyToMessageId?: string,
  title?: string,
  displayName?: string,
  description?: string,
  decisionReason?: string,
): Promise<void> {
  // Dedup
  const nowTs = Date.now();
  if (recentPermissionForwards.has(permissionRequestId)) {
    console.warn(`[permissions] Duplicate forward suppressed for ${permissionRequestId}`);
    return;
  }
  recentPermissionForwards.set(permissionRequestId, nowTs);
  for (const [id, ts] of recentPermissionForwards) {
    if (nowTs - ts > 30_000) recentPermissionForwards.delete(id);
  }

  console.log(`[permissions] Forwarding permission request: ${permissionRequestId} tool=${toolName}`);

  // Convert AskUserQuestion options to pseudo-suggestions for button rendering
  let effectiveSuggestions = suggestions;
  let questionMode: 'none' | 'single' | 'multi' | undefined;
  let toolInputJson: string | undefined;

  if (toolName.toLowerCase() === 'askuserquestion' && (!suggestions || suggestions.length === 0)) {
    questionMode = classifyQuestionMode(toolInput);
    // Store toolInput for all question modes so we can build updatedInput on answer
    toolInputJson = JSON.stringify(toolInput);
    // Use per-question ans: buttons for both single and multi — gives visual ✅ feedback on selection
    effectiveSuggestions = [];
  }

  // ExitPlanMode: plan text is shown in the approval card body, skip perm markdown
  const mdText = toolName.toLowerCase() === 'exitplanmode' ? '' : formatPermissionMarkdown(toolName, toolInput, title, description, decisionReason);

  // Build multi-question data if applicable
  const questions = Array.isArray(toolInput.questions) ? toolInput.questions as Question[] : [];
  const multiQuestionData = questionMode === 'multi' || questionMode === 'single' ? { questions } : undefined;

  // Send permission card with action buttons
  const result = await ctx.feishu.sendPermissionCard(chatId, mdText, permissionRequestId, replyToMessageId, effectiveSuggestions, multiQuestionData, toolName, toolInput);

  // Record the link
  if (result.ok && result.messageId) {
    try {
      ctx.store.insertPermissionLink({
        permissionRequestId,
        chatId,
        messageId: result.messageId,
        toolName,
        suggestions: effectiveSuggestions ? JSON.stringify(effectiveSuggestions) : '',
        questionMode,
        toolInput: toolInputJson,
      });
    } catch { /* best effort */ }
  }
}

/**
 * Handle a permission callback from an inline button press or text shortcut.
 * Returns true if the callback was recognized and handled.
 */
export async function handlePermissionCallback(
  ctx: AppContext,
  callbackData: string,
  callbackChatId: string,
  callbackMessageId?: string,
): Promise<boolean> {
  const parts = callbackData.split(':');
  if (parts.length < 3 || parts[0] !== 'perm') return false;

  const action = parts[1];
  // Parse permissionRequestId: for 'sug:N:id', 'ans:Q:O:id', id starts after action params
  let permissionRequestId: string;
  let suggestionIndex = -1;
  let questionIndex = -1;
  let optionIndex = -1;

  if (action === 'sug') {
    if (parts.length < 4) return false;
    suggestionIndex = parseInt(parts[2], 10);
    if (isNaN(suggestionIndex) || suggestionIndex < 0) return false;
    permissionRequestId = parts.slice(3).join(':');
  } else if (action === 'ans') {
    // perm:ans:{qIdx}:{oIdx}:{id}
    if (parts.length < 5) return false;
    questionIndex = parseInt(parts[2], 10);
    optionIndex = parseInt(parts[3], 10);
    if (isNaN(questionIndex) || isNaN(optionIndex) || questionIndex < 0 || optionIndex < 0) return false;
    permissionRequestId = parts.slice(4).join(':');
  } else {
    permissionRequestId = parts.slice(2).join(':');
  }

  const link = ctx.store.getPermissionLink(permissionRequestId);
  if (!link) {
    console.warn(`[permissions] No permission link found for ${permissionRequestId}`);
    return false;
  }

  if (link.chatId !== callbackChatId) {
    console.warn(`[permissions] Chat ID mismatch: expected ${link.chatId}, got ${callbackChatId}`);
    return false;
  }

  if (callbackMessageId && link.messageId !== callbackMessageId) {
    console.warn(`[permissions] Message ID mismatch: expected ${link.messageId}, got ${callbackMessageId}`);
    return false;
  }

  if (link.resolved) {
    console.warn(`[permissions] Permission ${permissionRequestId} already resolved`);
    return false;
  }

  let claimed: boolean;

  // 'ans' action: intermediate step for multi-question — don't resolve yet
  if (action === 'ans') {
    setMultiQuestionAnswer(permissionRequestId, questionIndex, optionIndex);
    const answers = getMultiQuestionAnswers(permissionRequestId)!;

    // Parse questions to check if all answered
    const questions: Question[] = link.toolInput ? (JSON.parse(link.toolInput).questions ?? []) : [];
    const allAnswered = questions.length > 0 && questions.every((_, qi) => answers.has(qi));

    // Update card with selected state
    await ctx.feishu.updateQuestionCard(permissionRequestId, questions, answers, link.chatId).catch(() => {});

    if (allAnswered) {
      // Auto-submit: build answers map and resolve
      try { ctx.store.markPermissionLinkResolved(permissionRequestId); } catch { /* */ }
      const answerMap: Record<string, string> = {};
      for (let qi = 0; qi < questions.length; qi++) {
        const q = questions[qi];
        const oi = answers.get(qi)!;
        const opt = q.options?.[oi];
        answerMap[q.question ?? `Question ${qi + 1}`] = opt?.label ?? '';
      }
      const updatedInput = link.toolInput ? { ...JSON.parse(link.toolInput), answers: answerMap } : { answers: answerMap };
      await ctx.feishu.resolvePermissionCard(permissionRequestId, 'allow', link.chatId).catch(() => {});
      const resolved = ctx.permissions.resolve(permissionRequestId, { behavior: 'allow', updatedInput });
      if (resolved) console.log(`[permissions] Multi-question auto-submitted: ${permissionRequestId}, answers=${JSON.stringify(answerMap)}`);
      clearMultiQuestionAnswers(permissionRequestId);
      return resolved;
    }

    return true; // Answer recorded, waiting for more
  }

  try {
    claimed = ctx.store.markPermissionLinkResolved(permissionRequestId);
  } catch {
    return false;
  }
  if (!claimed) return false;

  let resolved: boolean;
  let resolveAction: 'allow' | 'deny' = 'deny';

  switch (action) {
    case 'allow':
      resolveAction = 'allow';
      break;

    case 'sug': {
      resolveAction = 'allow';
      break;
    }

    case 'deny':
      break;

    default:
      return false;
  }

  // Update card FIRST (remove buttons, re-add to activeCards with approved flag)
  // This must complete before unblocking the SDK so that tool events can find the card
  const shouldFinalize = link.toolName.toLowerCase() === 'exitplanmode';
  await ctx.feishu.resolvePermissionCard(permissionRequestId, resolveAction, link.chatId, { finalize: shouldFinalize }).catch(() => {});

  // NOW unblock the SDK — tool execution starts, events will find the card in activeCards
  switch (action) {
    case 'allow':
      resolved = ctx.permissions.resolve(permissionRequestId, { behavior: 'allow' });
      break;

    case 'sug': {
      let updatedPermissions: PermissionUpdate[] | undefined;
      let updatedInput: Record<string, unknown> | undefined;
      if (link.suggestions) {
        try {
          const all = JSON.parse(link.suggestions) as Array<Record<string, unknown>>;
          if (Array.isArray(all) && suggestionIndex < all.length) {
            const sug = all[suggestionIndex];
            if (sug._questionOption) {
              // AskUserQuestion option — build answer from stored toolInput
              if (link.toolInput) {
                try {
                  const origInput = JSON.parse(link.toolInput);
                  const questions: Question[] = Array.isArray(origInput.questions) ? origInput.questions : [];
                  // Find which question/option this suggestion index maps to
                  let offset = 0;
                  for (const q of questions) {
                    const opts = q.options ?? [];
                    if (suggestionIndex < offset + opts.length) {
                      const opt = opts[suggestionIndex - offset];
                      const answerMap: Record<string, string> = {
                        [q.question ?? 'Question 1']: opt?.label ?? '',
                      };
                      updatedInput = { ...origInput, answers: answerMap };
                      break;
                    }
                    offset += opts.length;
                  }
                } catch { /* fall through */ }
              }
            } else {
              updatedPermissions = [sug as unknown as PermissionUpdate];
            }
          }
        } catch { /* fall through */ }
      }
      resolved = ctx.permissions.resolve(permissionRequestId, {
        behavior: 'allow',
        updatedPermissions,
        ...(updatedInput ? { updatedInput } : {}),
      });
      break;
    }

    case 'deny':
      resolved = ctx.permissions.resolve(permissionRequestId, {
        behavior: 'deny',
        message: 'Denied via IM bridge',
      });
      break;

    default:
      return false;
  }

  if (resolved) {
    console.log(`[permissions] Permission resolved: ${permissionRequestId}, action=${resolveAction}, chatId=${link.chatId}`);
  }

  return resolved;
}

// ── Permission Markdown formatting ──────────────────────────

/** Escape markdown special characters for Feishu card markdown. */
function escapeMd(text: string): string {
  return text.replace(/([\\`*_|~\[\](){}#!>+-])/g, '\\$1');
}

interface QuestionOption {
  label?: string;
  description?: string;
  preview?: string;
}

interface Question {
  question?: string;
  header?: string;
  options?: QuestionOption[];
  multiSelect?: boolean;
}

interface AllowedPrompt {
  tool?: string;
  prompt?: string;
}

/**
 * Format permission request markdown for Feishu card display.
 * Uses human-readable formatting for AskUserQuestion and ExitPlanMode;
 * falls back to code-block JSON for other tools.
 */
/**
 * Format permission request markdown for Feishu card display.
 * When embedded in streaming card, tool progress is already shown above,
 * so only title/description/decisionReason are rendered here.
 */
function formatPermissionMarkdown(toolName: string, input: Record<string, unknown>, title?: string, description?: string, decisionReason?: string): string {
  const lower = toolName.toLowerCase();

  if (lower === 'askuserquestion') {
    return formatAskUserQuestion(input);
  }

  if (lower === 'exitplanmode') {
    return formatExitPlanMode(input);
  }

  const lines: string[] = [];

  // Use SDK-provided title and description when available
  if (title) {
    lines.push(`**${title}**`);
    if (description) lines.push('', description);
    if (decisionReason) lines.push('', `_${decisionReason}_`);
  } else {
    lines.push('**Permission Required**');
  }

  return lines.join('\n');
}

/** Extract AskUserQuestion options as pseudo-suggestions for button rendering. */
function extractQuestionOptions(input: Record<string, unknown>): unknown[] {
  const questions = Array.isArray(input.questions) ? input.questions as Question[] : [];
  const options: unknown[] = [];
  for (const q of questions) {
    if (Array.isArray(q.options)) {
      for (const opt of q.options) {
        options.push({
          _questionOption: true as const,
          label: opt.label ?? '',
          description: opt.description,
        });
      }
    }
  }
  return options;
}

function formatAskUserQuestion(input: Record<string, unknown>): string {
  const questions = Array.isArray(input.questions) ? input.questions as Question[] : [];
  const lines: string[] = ['**Permission Required — AskUserQuestion**', ''];

  if (questions.length === 0) {
    lines.push('_No questions provided_');
  } else {
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      if (i > 0) lines.push('');

      const header = q.header ? ` \`${escapeMd(q.header)}\`` : '';
      lines.push(`**Q${i + 1}: ${escapeMd(q.question ?? '')}**${header}`);
      // Options are rendered as clickable buttons — no text bullets needed

      if (q.multiSelect) {
        lines.push('  _(multi-select)_');
      }
    }
  }

  return lines.join('\n');
}

function formatExitPlanMode(input: Record<string, unknown>): string {
  const prompts = Array.isArray(input.allowedPrompts) ? input.allowedPrompts as AllowedPrompt[] : [];
  const lines: string[] = ['**Plan Review — Approve to Start Implementation**', ''];

  if (prompts.length === 0) {
    lines.push('_No specific tools requested_');
  } else {
    for (const p of prompts) {
      const tool = p.tool ? `\`${escapeMd(p.tool)}\`` : '';
      const desc = p.prompt ? escapeMd(p.prompt) : '';
      if (tool && desc) {
        lines.push(`• ${tool} — ${desc}`);
      } else if (tool) {
        lines.push(`• ${tool}`);
      } else if (desc) {
        lines.push(`• ${desc}`);
      }
    }
  }

  return lines.join('\n');
}
