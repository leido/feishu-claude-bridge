/**
 * Feishu-specific Markdown processing.
 *
 * Rendering strategy:
 * - Code blocks / tables → interactive card (schema 2.0 markdown)
 * - Other text → post (msg_type: 'post') with md tag
 */

import type { ToolCallInfo } from './types.js';

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
    const icon = tc.status === 'running' ? '🔄' : tc.status === 'complete' ? '✅' : '❌';
    const detail = formatToolDetail(tc.name, tc.input);
    return detail ? `${icon} \`${tc.name}\` — ${detail}` : `${icon} \`${tc.name}\``;
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

export function buildStreamingContent(text: string, tools: ToolCallInfo[]): string {
  let content = text || '';
  const toolMd = buildToolProgressMarkdown(tools);
  if (toolMd) {
    content = content ? `${content}\n\n${toolMd}` : toolMd;
  }
  return content || '💭 Thinking...';
}

export function buildFinalCardJson(
  text: string,
  tools: ToolCallInfo[],
  footer: { status: string; elapsed: string; tokens?: string; cost?: string; context?: string } | null,
): string {
  const elements: Array<Record<string, unknown>> = [];

  let content = preprocessFeishuMarkdown(text);
  const toolMd = buildToolProgressMarkdown(tools);
  if (toolMd) {
    content = content ? `${content}\n\n${toolMd}` : toolMd;
  }

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

function buildPermButtons(
  permissionRequestId: string,
  chatId?: string,
  hasSuggestions?: boolean,
): { elements: Array<Record<string, unknown>>; hints: string } {
  const buttons = [
    { label: '✅ Allow', type: 'primary', action: 'allow' },
    { label: 'Allow Session', type: 'default', action: 'allow_session' },
  ];
  if (hasSuggestions) {
    buttons.push({ label: 'Always Allow', type: 'default', action: 'allow_session' });
  }
  buttons.push({ label: '❌ Deny', type: 'danger', action: 'deny' });

  const hints = hasSuggestions
    ? 'Or reply: `1` Allow · `2` Allow Session · `3` Always Allow · `4` Deny'
    : 'Or reply: `1` Allow · `2` Allow Session · `3` Deny';

  // Schema 2.0: buttons are direct elements with behaviors for callback
  const buttonElements = buttons.map((btn) => ({
    tag: 'button',
    type: btn.type === 'primary' ? 'primary_filled' : btn.type,
    size: 'medium',
    width: 'fill',
    text: { tag: 'plain_text', content: btn.label },
    behaviors: [{ type: 'callback', value: { callback_data: `perm:${btn.action}:${permissionRequestId}`, ...(chatId ? { chatId } : {}) } }],
  }));

  return { elements: buttonElements, hints };
}

export function buildPermissionButtonCard(
  text: string,
  permissionRequestId: string,
  chatId?: string,
  hasSuggestions?: boolean,
): string {
  const { elements: buttonElements, hints } = buildPermButtons(permissionRequestId, chatId, hasSuggestions);

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
  responseText: string,
  tools: ToolCallInfo[],
  permText: string,
  permissionRequestId: string,
  chatId?: string,
  hasSuggestions?: boolean,
): string {
  const elements: Array<Record<string, unknown>> = [];

  // Current response text + tool progress
  let content = preprocessFeishuMarkdown(responseText);
  const toolMd = buildToolProgressMarkdown(tools);
  if (toolMd) {
    content = content ? `${content}\n\n${toolMd}` : toolMd;
  }
  if (content) {
    elements.push({ tag: 'markdown', content, text_align: 'left', text_size: 'normal' });
  }

  // Permission section
  elements.push({ tag: 'hr' });
  elements.push({ tag: 'markdown', content: '**🔐 Permission Required**', text_size: 'normal' });
  if (permText) {
    elements.push({ tag: 'markdown', content: permText, text_size: 'normal' });
  }
  elements.push({ tag: 'markdown', content: '⏱ Expires in 5 minutes', text_size: 'notation' });

  // Buttons (reuse shared helper)
  const { elements: buttonElements, hints } = buildPermButtons(permissionRequestId, chatId, hasSuggestions);
  elements.push({ tag: 'hr' });
  elements.push(...buttonElements);
  elements.push({ tag: 'markdown', content: hints, text_size: 'notation' });

  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    body: { elements },
  });
}
