/**
 * Feishu-specific Markdown processing.
 *
 * Rendering strategy:
 * - Code blocks / tables → interactive card (schema 2.0 markdown)
 * - Other text → post (msg_type: 'post') with md tag
 */

import type { ToolCallInfo } from './types.js';

/** Safety margin below Feishu's ~28KB markdown element limit */
export const CARD_CONTENT_LIMIT = 26_000;

export function hasComplexMarkdown(text: string): boolean {
  if (/```[\s\S]*?```/.test(text)) return true;
  if (/\|.+\|[\r\n]+\|[-:| ]+\|/.test(text)) return true;
  return false;
}

export function preprocessFeishuMarkdown(text: string): string {
  return text.replace(/([^\n])```/g, '$1\n```');
}

export function buildCardContent(text: string): string {
  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    body: {
      elements: [{ tag: 'markdown', content: text }],
    },
  });
}

export function buildPostContent(text: string): string {
  return JSON.stringify({
    zh_cn: {
      content: [[{ tag: 'md', text }]],
    },
  });
}

export function htmlToFeishuMarkdown(html: string): string {
  return html
    .replace(/<b>(.*?)<\/b>/gi, '**$1**')
    .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<i>(.*?)<\/i>/gi, '*$1*')
    .replace(/<em>(.*?)<\/em>/gi, '*$1*')
    .replace(/<code>(.*?)<\/code>/gi, '`$1`')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function buildToolProgressMarkdown(tools: ToolCallInfo[]): string {
  if (tools.length === 0) return '';
  const lines = tools.map((tc) => {
    const icon = tc.status === 'running' ? '🔄' : tc.status === 'error' ? '❌' : '✅';
    const detail = formatToolDetail(tc.name, tc.input);
    const base = detail ? `${icon} \`${tc.name}\` — ${detail}` : `${icon} \`${tc.name}\``;
    if (tc.approved) return `${base}\n[approved]`;
    if ((tc as any).denied) return `${base}\n[denied]`;
    return base;
  });
  return lines.join('\n');
}

export function formatToolDetail(name: string, input?: Record<string, unknown>): string {
  if (!input) return '';
  const n = name.toLowerCase();

  // File operations
  if (n === 'read' || n === 'edit') {
    return `\`${input.file_path ?? input.path ?? ''}\``;
  }
  if (n === 'write') {
    return `\`${input.file_path ?? ''}\``;
  }
  if (n === 'glob') {
    return `\`${input.pattern ?? ''}\``;
  }

  // Search
  if (n === 'grep') {
    const pat = input.pattern ?? '';
    const glob = input.glob ?? '';
    return glob ? `/\`${pat}\` in \`${glob}\`` : `/\`${pat}\``;
  }

  // Shell
  if (n === 'bash') {
    const cmd = String(input.command ?? '');
    const preview = cmd.length > 60 ? cmd.slice(0, 60) + '...' : cmd;
    return `\`${preview}\``;
  }

  // Agent
  if (n === 'agent' || n === 'todo_write' || n === 'todo_read') {
    return '';
  }

  // Generic: show first meaningful field
  for (const val of Object.values(input)) {
    if (typeof val === 'string' && val) {
      const preview = val.length > 60 ? val.slice(0, 60) + '...' : val;
      return `\`${preview}\``;
    }
  }
  return '';
}

export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const remSec = Math.floor(sec % 60);
  return `${min}m ${remSec}s`;
}

export function formatTokenCount(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}K`;
  return `${Math.round(count / 1000)}K`;
}

export function buildCycleMarker(cycleNumber: number, elapsedMs: number): string {
  return `[cycle ${cycleNumber} complete ${formatElapsed(elapsedMs)}]`;
}

export function buildStreamingContent(accumulated: string, text: string, tools: ToolCallInfo[]): string {
  const parts: string[] = [];
  if (accumulated) parts.push(accumulated);
  if (text && text.trim()) parts.push(text);
  const toolMd = buildToolProgressMarkdown(tools);
  if (toolMd) parts.push(toolMd);
  if (parts.length === 0) return '💭 Thinking...';
  // No blank line between text and running tools; blank line only between accumulated and current content
  return parts.length > 1 && accumulated
    ? `${parts[0]}\n\n${parts.slice(1).join('\n')}`
    : parts.join('\n');
}

export function buildFinalCardJson(
  accumulated: string,
  text: string,
  tools: ToolCallInfo[],
  footer: { status: string; elapsed: string; tokens?: string; cost?: string; context?: string } | null,
): string {
  const elements: Array<Record<string, unknown>> = [];

  const parts: string[] = [];
  if (accumulated) parts.push(preprocessFeishuMarkdown(accumulated));
  if (text && text.trim()) parts.push(preprocessFeishuMarkdown(text));
  const toolMd = buildToolProgressMarkdown(tools);
  if (toolMd) parts.push(toolMd);
  const content = parts.join('\n\n');

  if (content) {
    elements.push({
      tag: 'markdown',
      content,
      text_align: 'left',
      text_size: 'normal',
    });
  }

  if (footer) {
    const parts: string[] = [];
    if (footer.status) parts.push(footer.status);
    if (footer.elapsed) parts.push(footer.elapsed);
    if (footer.tokens) parts.push(footer.tokens);
    if (footer.cost) parts.push(footer.cost);
    if (footer.context) parts.push(`ctx ${footer.context}`);
    if (parts.length > 0) {
      elements.push({ tag: 'hr' });
      elements.push({
        tag: 'markdown',
        content: parts.join(' · '),
        text_size: 'notation',
      });
    }
  }

  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    body: { elements },
  });
}

interface PermissionSuggestion {
  type: string;
  destination?: string;
  [key: string]: unknown;
}

const DESTINATION_LABELS: Record<string, string> = {
  session: 'Allow for session',
  projectSettings: 'Allow for project',
  localSettings: 'Allow locally',
  userSettings: 'Always allow',
  cliArg: 'Allow',
};

function buildPermButtons(
  permissionRequestId: string,
  chatId?: string,
  suggestions?: unknown[],
): { elements: Array<Record<string, unknown>>; hints: string } {
  const buttons: Array<{ label: string; type: string; action: string }> = [
    { label: 'Allow once', type: 'primary_filled', action: 'allow' },
  ];

  const sugHints: string[] = ['`1` Allow once'];

  if (Array.isArray(suggestions)) {
    for (let i = 0; i < suggestions.length; i++) {
      const sug = suggestions[i] as PermissionSuggestion;
      if (sug._questionOption) {
        // AskUserQuestion option — use the option's label as button text
        const label = (sug.label as string) || '_(unnamed)_';
        const desc = sug.description as string | undefined;
        const hint = desc ? `${label} — ${desc}` : label;
        buttons.push({ label, type: 'primary', action: `sug:${i}` });
        sugHints.push(`\`${i + 2}\` ${hint}`);
      } else {
        const label = DESTINATION_LABELS[sug.destination ?? ''] ?? `Allow (${sug.destination ?? 'unknown'})`;
        buttons.push({ label, type: 'primary', action: `sug:${i}` });
        sugHints.push(`\`${i + 2}\` ${label}`);
      }
    }
  }

  buttons.push({ label: 'Deny', type: 'danger', action: 'deny' });
  sugHints.push(`\`${buttons.length}\` Deny`);

  // Schema 2.0: buttons are direct elements with behaviors for callback
  const buttonElements = buttons.map((btn) => ({
    tag: 'button',
    type: btn.type,
    size: 'medium',
    width: 'fill',
    text: { tag: 'plain_text', content: btn.label },
    behaviors: [{ type: 'callback', value: { callback_data: `perm:${btn.action}:${permissionRequestId}`, ...(chatId ? { chatId } : {}) } }],
  }));

  const hints = `Or reply: ${sugHints.join(' · ')}`;
  return { elements: buttonElements, hints };
}

export function buildPermissionButtonCard(
  text: string,
  permissionRequestId: string,
  chatId?: string,
  suggestions?: unknown[],
): string {
  const { elements: buttonElements, hints } = buildPermButtons(permissionRequestId, chatId, suggestions);

  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: 'Permission Required' },
      template: 'blue',
      icon: { tag: 'standard_icon', token: 'lock-chat_filled' },
      padding: '12px 12px 12px 12px',
    },
    body: {
      elements: [
        { tag: 'markdown', content: text, text_size: 'normal' },
        { tag: 'markdown', content: '⏱ Expires in 5 minutes', text_size: 'notation' },
        { tag: 'hr' },
        ...buttonElements,
        { tag: 'markdown', content: hints, text_size: 'notation' },
      ],
    },
  });
}

export function buildPermissionResolvedCard(
  text: string,
  action: 'allow' | 'allow_session' | 'deny',
): string {
  const statusIcon = action === 'deny' ? '❌ Denied' : '✅ Allowed';
  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: 'Permission Resolved' },
      template: action === 'deny' ? 'red' : 'green',
      icon: { tag: 'standard_icon', token: action === 'deny' ? 'reject_filled' : 'approve_filled' },
      padding: '12px 12px 12px 12px',
    },
    body: {
      elements: [
        { tag: 'markdown', content: text, text_size: 'normal' },
        { tag: 'hr' },
        { tag: 'markdown', content: statusIcon, text_size: 'normal' },
      ],
    },
  });
}

export function buildStreamingPermissionCard(
  accumulated: string,
  responseText: string,
  tools: ToolCallInfo[],
  permText: string,
  permissionRequestId: string,
  chatId?: string,
  suggestions?: unknown[],
): string {
  const elements: Array<Record<string, unknown>> = [];

  // Accumulated + current response text + tool progress
  const parts: string[] = [];
  if (accumulated) parts.push(accumulated);
  if (responseText && responseText.trim()) parts.push(preprocessFeishuMarkdown(responseText));
  const toolMd = buildToolProgressMarkdown(tools);
  if (toolMd) parts.push(toolMd);
  const content = parts.join('\n\n');
  if (content) {
    elements.push({ tag: 'markdown', content, text_align: 'left', text_size: 'normal' });
  }

  // Permission section
  elements.push({ tag: 'hr' });
  if (permText) {
    elements.push({ tag: 'markdown', content: permText, text_size: 'normal' });
  }
  elements.push({ tag: 'markdown', content: '⏱ Expires in 5 minutes', text_size: 'notation' });

  // Buttons (reuse shared helper)
  const { elements: buttonElements, hints } = buildPermButtons(permissionRequestId, chatId, suggestions);
  elements.push({ tag: 'hr' });
  elements.push(...buttonElements);
  elements.push({ tag: 'markdown', content: hints, text_size: 'notation' });

  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    body: { elements },
  });
}

/**
 * Build a card after permission is resolved — just normal streaming content
 * with updated tool icons (🔄→✅/❌). No text status line since it would be
 * overwritten by subsequent streaming updates anyway.
 */
export function buildPermResolvedStreamingCard(
  accumulated: string,
  responseText: string,
  tools: ToolCallInfo[],
  _permText: string,
  _action: 'allow' | 'deny',
): string {
  const parts: string[] = [];
  if (accumulated) parts.push(accumulated);
  if (responseText && responseText.trim()) parts.push(preprocessFeishuMarkdown(responseText));
  const toolMd = buildToolProgressMarkdown(tools);
  if (toolMd) parts.push(toolMd);
  const content = parts.join('\n\n');

  return JSON.stringify({
    schema: '2.0',
    config: { streaming_mode: true, wide_screen_mode: true },
    body: {
      elements: [{
        tag: 'markdown',
        content: content || '💭 Thinking...',
        text_align: 'left',
        text_size: 'normal',
        element_id: 'streaming_content',
      }],
    },
  });
}
