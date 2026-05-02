/**
 * Pending Permissions — Promise-based gateway for tool permission requests.
 *
 * waitFor() returns a promise that resolves when the IM user allows/denies.
 * 5-minute timeout auto-deny. denyAll() for graceful shutdown.
 *
 * Also contains permission forwarding and callback handling logic
 * (merged from permission-broker.ts + permission-gateway.ts).
 */

import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionResult, AppContext } from './types.js';
import {
  buildPermissionButtonCard,
  formatToolDetail,
} from './feishu-markdown.js';

export class PendingPermissions {
  private pending = new Map<string, {
    resolve: (r: PermissionResult) => void;
    timer: NodeJS.Timeout;
  }>();
  private timeoutMs = 5 * 60 * 1000;

  waitFor(toolUseID: string): Promise<PermissionResult> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(toolUseID);
        resolve({ behavior: 'deny', message: 'Permission request timed out' });
      }, this.timeoutMs);
      this.pending.set(toolUseID, { resolve, timer });
    });
  }

  resolve(permissionRequestId: string, resolution: { behavior: 'allow' | 'deny'; message?: string }): boolean {
    const entry = this.pending.get(permissionRequestId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    if (resolution.behavior === 'allow') {
      entry.resolve({ behavior: 'allow' });
    } else {
      entry.resolve({ behavior: 'deny', message: resolution.message || 'Denied by user' });
    }
    this.pending.delete(permissionRequestId);
    return true;
  }

  denyAll(): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
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

  const mdText = formatPermissionMarkdown(toolName, toolInput, title, description, decisionReason);

  // Send permission card with action buttons
  const result = await ctx.feishu.sendPermissionCard(chatId, mdText, permissionRequestId, replyToMessageId, suggestions);

  // Record the link
  if (result.ok && result.messageId) {
    try {
      ctx.store.insertPermissionLink({
        permissionRequestId,
        chatId,
        messageId: result.messageId,
        toolName,
        suggestions: suggestions ? JSON.stringify(suggestions) : '',
      });
    } catch { /* best effort */ }
  }
}

/**
 * Handle a permission callback from an inline button press or text shortcut.
 * Returns true if the callback was recognized and handled.
 */
export function handlePermissionCallback(
  ctx: AppContext,
  callbackData: string,
  callbackChatId: string,
  callbackMessageId?: string,
): boolean {
  const parts = callbackData.split(':');
  if (parts.length < 3 || parts[0] !== 'perm') return false;

  const action = parts[1];
  // Parse permissionRequestId: for 'sug:N:id', id starts at parts[3]
  let permissionRequestId: string;
  let suggestionIndex = -1;

  if (action === 'sug') {
    if (parts.length < 4) return false;
    suggestionIndex = parseInt(parts[2], 10);
    if (isNaN(suggestionIndex) || suggestionIndex < 0) return false;
    permissionRequestId = parts.slice(3).join(':');
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
  try {
    claimed = ctx.store.markPermissionLinkResolved(permissionRequestId);
  } catch {
    return false;
  }
  if (!claimed) return false;

  let resolved: boolean;

  switch (action) {
    case 'allow':
      resolved = ctx.permissions.resolve(permissionRequestId, { behavior: 'allow' });
      break;

    case 'sug': {
      let updatedPermissions: PermissionUpdate[] | undefined;
      if (link.suggestions) {
        try {
          const all = JSON.parse(link.suggestions) as PermissionUpdate[];
          if (Array.isArray(all) && suggestionIndex < all.length) {
            updatedPermissions = [all[suggestionIndex]];
          }
        } catch { /* fall through */ }
      }
      resolved = ctx.permissions.resolve(permissionRequestId, {
        behavior: 'allow',
        updatedPermissions,
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
function formatPermissionMarkdown(toolName: string, input: Record<string, unknown>, title?: string, description?: string, decisionReason?: string): string {
  const lower = toolName.toLowerCase();

  if (lower === 'askuserquestion') {
    return formatAskUserQuestion(input);
  }

  if (lower === 'exitplanmode') {
    return formatExitPlanMode(input);
  }

  // Build tool call format: 🔄 `ToolName` — detail
  const detail = formatToolDetail(toolName, input);
  const toolLine = detail ? `🔄 \`${toolName}\` — ${detail}` : `🔄 \`${toolName}\``;

  const lines: string[] = [];

  // Use SDK-provided title and description when available
  if (title) {
    lines.push(`**${title}**`);
    if (description) lines.push('', description);
    if (decisionReason) lines.push('', `_${decisionReason}_`);
  } else {
    lines.push('**Permission Required**');
  }

  lines.push('', toolLine);
  return lines.join('\n');
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

      if (Array.isArray(q.options) && q.options.length > 0) {
        for (const opt of q.options) {
          const label = opt.label ? `**${escapeMd(opt.label)}**` : '_(unnamed)_';
          const desc = opt.description ? ` — ${escapeMd(opt.description)}` : '';
          lines.push(`  • ${label}${desc}`);
        }
      }

      if (q.multiSelect) {
        lines.push('  _(multi-select)_');
      }
    }
  }

  return lines.join('\n');
}

function formatExitPlanMode(input: Record<string, unknown>): string {
  const prompts = Array.isArray(input.allowedPrompts) ? input.allowedPrompts as AllowedPrompt[] : [];
  const lines: string[] = ['**Permission Required — Exit Plan Mode**', ''];

  if (prompts.length === 0) {
    lines.push('_No specific permissions requested — approves the plan_');
  } else {
    lines.push('Allowed tools:');
    for (const p of prompts) {
      const tool = p.tool ? `\`${escapeMd(p.tool)}\`` : '_(unknown)_';
      const desc = p.prompt ? ` — ${escapeMd(p.prompt)}` : '';
      lines.push(`  • ${tool}${desc}`);
    }
  }

  return lines.join('\n');
}
