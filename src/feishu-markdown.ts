/**
 * Feishu-specific Markdown processing.
 *
 * Rendering strategy:
 * - Code blocks / tables → interactive card (schema 2.0 markdown)
 * - Other text → post (msg_type: 'post') with md tag
 */

import type { ToolCallInfo } from "./types.js";

/** Safety margin below Feishu's ~28KB markdown element limit */
export const CARD_CONTENT_LIMIT = 26_000;

export function hasComplexMarkdown(text: string): boolean {
  if (/```[\s\S]*?```/.test(text)) return true;
  if (/\|.+\|[\r\n]+\|[-:| ]+\|/.test(text)) return true;
  return false;
}

export function preprocessFeishuMarkdown(text: string): string {
  return text.replace(/([^\n])```/g, "$1\n```");
}

export function buildCardContent(text: string): string {
  return JSON.stringify({
    schema: "2.0",
    config: { wide_screen_mode: true },
    body: {
      elements: [{ tag: "markdown", content: text }],
    },
  });
}

export function buildPostContent(text: string): string {
  return JSON.stringify({
    zh_cn: {
      content: [[{ tag: "md", text }]],
    },
  });
}

export function htmlToFeishuMarkdown(html: string): string {
  return html
    .replace(/<b>(.*?)<\/b>/gi, "**$1**")
    .replace(/<strong>(.*?)<\/strong>/gi, "**$1**")
    .replace(/<i>(.*?)<\/i>/gi, "*$1*")
    .replace(/<em>(.*?)<\/em>/gi, "*$1*")
    .replace(/<code>(.*?)<\/code>/gi, "`$1`")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function buildToolProgressMarkdown(tools: ToolCallInfo[]): string {
  if (tools.length === 0) return "";
  const lines = tools.map((tc) => {
    const icon =
      tc.status === "running" ? "🔄" : tc.status === "error" ? "❌" : "✅";

    // TodoWrite — render as task list with quote indentation
    const n = tc.name.toLowerCase().replace(/_/g, "");
    if (
      (n === "todowrite" || n === "todoread") &&
      tc.input &&
      Array.isArray(tc.input.todos)
    ) {
      const todos = tc.input.todos as Array<{
        content: string;
        status: string;
        activeForm?: string;
      }>;
      const taskLines = todos.slice(0, 8).map((t) => {
        const s =
          t.status === "completed"
            ? "✅"
            : t.status === "in_progress"
              ? "🔄"
              : "⬜";
        const text =
          t.content.length > 50 ? t.content.slice(0, 50) + "..." : t.content;
        const lines = text.split("\n");
        return [
          `> ${s} ${lines[0]}`,
          ...lines.slice(1).map((l) => `> ${l}`),
        ].join("\n");
      });
      const suffix =
        todos.length > 8 ? `\n> ... +${todos.length - 8} more` : "";
      return `${icon} \`${tc.name}\` (${todos.length})\n${taskLines.join("\n")}${suffix}\n`;
    }

    const detail = formatToolDetail(tc.name, tc.input);
    const base = detail
      ? `${icon} \`${tc.name}\` — ${detail}`
      : `${icon} \`${tc.name}\``;
    if (tc.status === "error" && tc.error) {
      const oneLine = tc.error.replace(/\n+/g, " ").trim();
      const errPreview =
        oneLine.length > 200 ? oneLine.slice(0, 200) + "..." : oneLine;
      const errLines = errPreview.split("\n");
      return (
        `${base}\n` +
        [`> ⚠️ ${errLines[0]}`, ...errLines.slice(1).map((l) => `> ${l}`)].join(
          "\n",
        ) +
        "\n"
      );
    }
    if (tc.approved) return `${base}\n> [approved]\n`;
    if ((tc as any).denied) return `${base}\n> [denied]\n`;
    return base;
  });
  return lines.join("\n");
}

export function formatToolDetail(
  name: string,
  input?: Record<string, unknown>,
): string {
  if (!input) return "";
  const n = name.toLowerCase();

  // File operations
  if (n === "read" || n === "edit") {
    return `\`${input.file_path ?? input.path ?? ""}\``;
  }
  if (n === "write") {
    return `\`${input.file_path ?? ""}\``;
  }
  if (n === "glob") {
    return `\`${input.pattern ?? ""}\``;
  }

  // Search
  if (n === "grep") {
    const pat = input.pattern ?? "";
    const glob = input.glob ?? "";
    return glob ? `/\`${pat}\` in \`${glob}\`` : `/\`${pat}\``;
  }

  // Shell
  if (n === "bash") {
    const cmd = String(input.command ?? "");
    const preview = cmd.length > 60 ? cmd.slice(0, 60) + "..." : cmd;
    return `\`${preview}\``;
  }

  // Agent / TodoWrite / ExitPlanMode — suppress detail (shown elsewhere)
  if (
    n === "agent" ||
    n === "todo_write" ||
    n === "todo_read" ||
    n === "todowrite" ||
    n === "todoread" ||
    n === "exitplanmode"
  ) {
    return "";
  }

  // Generic: show first meaningful field
  for (const val of Object.values(input)) {
    if (typeof val === "string" && val) {
      const preview = val.length > 60 ? val.slice(0, 60) + "..." : val;
      return `\`${preview}\``;
    }
  }
  return "";
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

export function buildStreamingContent(
  accumulated: string,
  text: string,
  tools: ToolCallInfo[],
): string {
  const parts: string[] = [];
  // Strip trailing newlines so the separator adds exactly one blank line
  if (accumulated) parts.push(accumulated.replace(/\n+$/, ""));
  if (text && text.trim()) parts.push(text);
  const toolMd = buildToolProgressMarkdown(tools);
  if (toolMd) parts.push(toolMd);
  if (parts.length === 0) return "💭 Thinking...";
  // No blank line between text and running tools; blank line only between accumulated and current content
  return parts.length > 1 && accumulated
    ? `${parts[0]}\n\n${parts.slice(1).join("\n")}`
    : parts.join("\n");
}

export function buildFinalCardJson(
  accumulated: string,
  text: string,
  tools: ToolCallInfo[],
  footer: {
    status: string;
    elapsed: string;
    tokens?: string;
    cost?: string;
    context?: string;
  } | null,
): string {
  const elements: Array<Record<string, unknown>> = [];

  const parts: string[] = [];
  if (accumulated) parts.push(preprocessFeishuMarkdown(accumulated).replace(/\n+$/, ""));
  if (text && text.trim()) parts.push(preprocessFeishuMarkdown(text));
  const toolMd = buildToolProgressMarkdown(tools);
  if (toolMd) parts.push(toolMd);
  const content = parts.join("\n\n");

  if (content) {
    elements.push({
      tag: "markdown",
      content,
      text_align: "left",
      text_size: "normal",
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
      elements.push({ tag: "hr" });
      elements.push({
        tag: "markdown",
        content: parts.join(" · "),
        text_size: "notation",
      });
    }
  }

  return JSON.stringify({
    schema: "2.0",
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
  session: "Allow for session",
  projectSettings: "Allow for project",
  localSettings: "Allow locally",
  userSettings: "Always allow",
  cliArg: "Allow",
};

function buildPermButtons(
  permissionRequestId: string,
  chatId?: string,
  suggestions?: unknown[],
): { elements: Array<Record<string, unknown>>; hints: string } {
  const buttons: Array<{ label: string; type: string; action: string }> = [
    { label: "Allow once", type: "primary_filled", action: "allow" },
  ];

  const sugHints: string[] = ["`1` Allow once"];

  if (Array.isArray(suggestions)) {
    for (let i = 0; i < suggestions.length; i++) {
      const sug = suggestions[i] as PermissionSuggestion;
      if (sug._questionOption) {
        // AskUserQuestion option — use the option's label as button text
        const label = (sug.label as string) || "_(unnamed)_";
        const desc = sug.description as string | undefined;
        const hint = desc ? `${label} — ${desc}` : label;
        buttons.push({ label, type: "primary", action: `sug:${i}` });
        sugHints.push(`\`${i + 2}\` ${hint}`);
      } else {
        const label =
          DESTINATION_LABELS[sug.destination ?? ""] ??
          `Allow (${sug.destination ?? "unknown"})`;
        buttons.push({ label, type: "primary", action: `sug:${i}` });
        sugHints.push(`\`${i + 2}\` ${label}`);
      }
    }
  }

  buttons.push({ label: "Deny", type: "danger", action: "deny" });
  sugHints.push(`\`${buttons.length}\` Deny`);

  // Schema 2.0: buttons are direct elements with behaviors for callback
  const buttonElements = buttons.map((btn) => ({
    tag: "button",
    type: btn.type,
    size: "medium",
    width: "fill",
    text: { tag: "plain_text", content: btn.label },
    behaviors: [
      {
        type: "callback",
        value: {
          callback_data: `perm:${btn.action}:${permissionRequestId}`,
          ...(chatId ? { chatId } : {}),
        },
      },
    ],
  }));

  const hints = `Or reply: ${sugHints.join(" · ")}`;
  return { elements: buttonElements, hints };
}

// ── Multi-question AskUserQuestion card rendering ──────────────

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

function buildMultiQuestionPermButtons(
  permissionRequestId: string,
  chatId: string,
  questions: Question[],
  answers: Map<number, number>,
): { elements: Array<Record<string, unknown>>; hints: string } {
  const elements: Array<Record<string, unknown>> = [];
  const hintParts: string[] = [];

  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi];
    const header = q.header ? ` \`${q.header}\`` : "";
    const qText = q.question ?? `Question ${qi + 1}`;
    const selectedOi = answers.get(qi);

    // Question header
    elements.push({
      tag: "markdown",
      content: `**Q${qi + 1}: ${qText}**${header}`,
      text_size: "normal",
    });

    // Option buttons for this question
    const optBtns: Array<Record<string, unknown>> = [];
    if (q.options) {
      for (let oi = 0; oi < q.options.length; oi++) {
        const opt = q.options[oi];
        const isSelected = selectedOi === oi;
        const label = isSelected
          ? `✅ ${opt.label ?? "_(unnamed)_"}`
          : (opt.label ?? "_(unnamed)_");
        optBtns.push({
          tag: "button",
          type: isSelected ? "primary_filled" : "primary",
          size: "medium",
          width: "fill",
          text: { tag: "plain_text", content: label },
          behaviors: [
            {
              type: "callback",
              value: {
                callback_data: `perm:ans:${qi}:${oi}:${permissionRequestId}`,
                chatId,
              },
            },
          ],
        });
        hintParts.push(`\`${qi + 1}.${oi + 1}\` ${opt.label ?? "_(unnamed)_"}`);
      }
    }

    elements.push({
      tag: "column_set",
      columns: optBtns.map((btn) => ({
        tag: "column",
        width: "auto",
        elements: [btn],
      })),
    });
  }

  // Deny button
  elements.push({ tag: "hr" });
  elements.push({
    tag: "button",
    type: "danger",
    size: "medium",
    width: "fill",
    text: { tag: "plain_text", content: "Deny" },
    behaviors: [
      {
        type: "callback",
        value: { callback_data: `perm:deny:${permissionRequestId}`, chatId },
      },
    ],
  });

  const hints =
    hintParts.length > 0 ? `Or reply: ${hintParts.join(" · ")}` : "";
  return { elements, hints };
}

export function buildMultiQuestionCard(
  text: string,
  permissionRequestId: string,
  chatId: string,
  questions: Question[],
  answers: Map<number, number>,
): string {
  const { elements: questionElements, hints } = buildMultiQuestionPermButtons(
    permissionRequestId,
    chatId,
    questions,
    answers,
  );

  const bodyElements: Array<Record<string, unknown>> = [
    { tag: "markdown", content: text, text_size: "normal" },
    { tag: "hr" },
    ...questionElements,
  ];
  if (hints)
    bodyElements.push({
      tag: "markdown",
      content: hints,
      text_size: "notation",
    });

  return JSON.stringify({
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "Permission Required" },
      template: "blue",
      icon: { tag: "standard_icon", token: "lock-chat_filled" },
      padding: "12px 12px 12px 12px",
    },
    body: { elements: bodyElements },
  });
}

export function buildMultiQuestionStreamingCard(
  accumulated: string,
  responseText: string,
  tools: ToolCallInfo[],
  permText: string,
  permissionRequestId: string,
  chatId: string,
  questions: Question[],
  answers: Map<number, number>,
): string {
  const elements: Array<Record<string, unknown>> = [];

  // Accumulated + current response text + tool progress
  const parts: string[] = [];
  if (accumulated) parts.push(accumulated.replace(/\n+$/, ""));
  if (responseText && responseText.trim())
    parts.push(preprocessFeishuMarkdown(responseText));
  const toolMd = buildToolProgressMarkdown(tools);
  if (toolMd) parts.push(toolMd);
  const content = parts.join("\n\n");
  if (content) {
    elements.push({
      tag: "markdown",
      content,
      text_align: "left",
      text_size: "normal",
    });
  }

  // Permission section with multi-question buttons
  elements.push({ tag: "hr" });
  if (permText) {
    elements.push({ tag: "markdown", content: permText, text_size: "normal" });
  }


  const { elements: questionElements, hints } = buildMultiQuestionPermButtons(
    permissionRequestId,
    chatId,
    questions,
    answers,
  );
  elements.push(...questionElements);
  if (hints)
    elements.push({ tag: "markdown", content: hints, text_size: "notation" });

  return JSON.stringify({
    schema: "2.0",
    config: { wide_screen_mode: true, streaming_mode: true },
    body: {
      elements: [
        ...elements,
        { tag: "streaming_content", element_id: "streaming_content" },
      ],
    },
  });
}

export function buildPermissionButtonCard(
  text: string,
  permissionRequestId: string,
  chatId?: string,
  suggestions?: unknown[],
): string {
  const { elements: buttonElements, hints } = buildPermButtons(
    permissionRequestId,
    chatId,
    suggestions,
  );

  return JSON.stringify({
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "Permission Required" },
      template: "blue",
      icon: { tag: "standard_icon", token: "lock-chat_filled" },
      padding: "12px 12px 12px 12px",
    },
    body: {
      elements: [
        { tag: "markdown", content: text, text_size: "normal" },
        { tag: "hr" },
        ...buttonElements,
        { tag: "markdown", content: hints, text_size: "notation" },
      ],
    },
  });
}

export function buildPermissionResolvedCard(
  text: string,
  action: "allow" | "allow_session" | "deny",
): string {
  const statusIcon = action === "deny" ? "❌ Denied" : "✅ Allowed";
  return JSON.stringify({
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "Permission Resolved" },
      template: action === "deny" ? "red" : "green",
      icon: {
        tag: "standard_icon",
        token: action === "deny" ? "reject_filled" : "approve_filled",
      },
      padding: "12px 12px 12px 12px",
    },
    body: {
      elements: [
        { tag: "markdown", content: text, text_size: "normal" },
        { tag: "hr" },
        { tag: "markdown", content: statusIcon, text_size: "normal" },
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
  if (accumulated) parts.push(accumulated.replace(/\n+$/, ""));
  if (responseText && responseText.trim())
    parts.push(preprocessFeishuMarkdown(responseText));
  const toolMd = buildToolProgressMarkdown(tools);
  if (toolMd) parts.push(toolMd);
  const content = parts.join("\n\n");
  if (content) {
    elements.push({
      tag: "markdown",
      content,
      text_align: "left",
      text_size: "normal",
    });
  }

  // Permission section
  elements.push({ tag: "hr" });
  if (permText) {
    elements.push({ tag: "markdown", content: permText, text_size: "normal" });
  }


  // Buttons (reuse shared helper)
  const { elements: buttonElements, hints } = buildPermButtons(
    permissionRequestId,
    chatId,
    suggestions,
  );
  elements.push({ tag: "hr" });
  elements.push(...buttonElements);
  elements.push({ tag: "markdown", content: hints, text_size: "notation" });

  return JSON.stringify({
    schema: "2.0",
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
  _action: "allow" | "deny",
): string {
  const parts: string[] = [];
  if (accumulated) parts.push(accumulated);
  if (responseText && responseText.trim())
    parts.push(preprocessFeishuMarkdown(responseText));
  const toolMd = buildToolProgressMarkdown(tools);
  if (toolMd) parts.push(toolMd);
  const content = parts.join("\n");

  return JSON.stringify({
    schema: "2.0",
    config: { streaming_mode: true, wide_screen_mode: true },
    body: {
      elements: [
        {
          tag: "markdown",
          content: content || "💭 Thinking...",
          text_align: "left",
          text_size: "normal",
          element_id: "streaming_content",
        },
      ],
    },
  });
}

/**
 * Build a dedicated plan approval card for ExitPlanMode.
 * Shows the plan text with a header and approval buttons.
 */
export function buildPlanApprovalCard(
  planText: string,
  permText: string,
  permissionRequestId: string,
  chatId?: string,
  suggestions?: unknown[],
): string {
  const elements: Array<Record<string, unknown>> = [];

  // Plan content
  if (planText) {
    elements.push({
      tag: "markdown",
      content: preprocessFeishuMarkdown(planText),
      text_align: "left",
      text_size: "normal",
    });
  }

  // Permission section
  elements.push({ tag: "hr" });
  if (permText) {
    elements.push({ tag: "markdown", content: permText, text_size: "normal" });
  }


  // Buttons
  const { elements: buttonElements, hints } = buildPermButtons(
    permissionRequestId,
    chatId,
    suggestions,
  );
  elements.push({ tag: "hr" });
  elements.push(...buttonElements);
  elements.push({ tag: "markdown", content: hints, text_size: "notation" });

  return JSON.stringify({
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "📋 Plan Approval" },
      template: "blue",
      icon: { tag: "standard_icon", token: "approve_filled" },
      padding: "12px 12px 12px 12px",
    },
    body: { elements },
  });
}

/**
 * Build the resolved plan approval card (after user clicks Allow/Deny).
 */
export function buildPlanApprovalResolvedCard(
  planText: string,
  action: "allow" | "deny",
): string {
  const statusIcon = action === "deny" ? "❌ Plan Denied" : "✅ Plan Approved";
  const elements: Array<Record<string, unknown>> = [];

  if (planText) {
    elements.push({
      tag: "markdown",
      content: preprocessFeishuMarkdown(planText),
      text_align: "left",
      text_size: "normal",
    });
  }

  elements.push({ tag: "hr" });
  elements.push({
    tag: "markdown",
    content: statusIcon,
    text_size: "normal",
  });

  return JSON.stringify({
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "📋 Plan Approval" },
      template: action === "deny" ? "red" : "green",
      icon: {
        tag: "standard_icon",
        token: action === "deny" ? "reject_filled" : "approve_filled",
      },
      padding: "12px 12px 12px 12px",
    },
    body: { elements },
  });
}

// ── /new directory selection card ──────────────────────────

export function buildDirSelectCard(
  dirs: string[],
  chatId: string,
): string {
  const elements: Array<Record<string, unknown>> = [
    { tag: "markdown", content: "**选择工作目录：**", text_size: "normal" },
    { tag: "hr" },
  ];

  for (let i = 0; i < dirs.length; i++) {
    const basename = dirs[i].split("/").pop() || dirs[i];
    elements.push({
      tag: "button",
      type: "primary",
      size: "medium",
      width: "fill",
      text: { tag: "plain_text", content: basename },
      behaviors: [
        {
          type: "callback",
          value: {
            callback_data: `newdir:${i}`,
            chatId,
          },
        },
      ],
    });
  }

  elements.push({ tag: "hr" });
  elements.push({
    tag: "markdown",
    content: "或回复 `/new <路径>` 输入新路径",
    text_size: "notation",
  });

  return JSON.stringify({
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "New Session" },
      template: "blue",
      icon: { tag: "standard_icon", token: "create_filled" },
      padding: "12px 12px 12px 12px",
    },
    body: { elements },
  });
}

// ── /continue session selection card ──────────────────────

export function buildContinueSelectCard(
  sessions: Array<{
    sdkSessionId: string;
    project: string;
    cwd: string;
    firstPrompt: string;
    isOpen: boolean;
    timestamp: number;
  }>,
  chatId: string,
): string {
  const elements: Array<Record<string, unknown>> = [
    { tag: "markdown", content: "**选择会话继续：**", text_size: "normal" },
    { tag: "hr" },
  ];

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const icon = s.isOpen ? "🟢" : "⚪";
    const prompt =
      s.firstPrompt.length > 30
        ? s.firstPrompt.slice(0, 30) + "..."
        : s.firstPrompt;
    elements.push({
      tag: "button",
      type: s.isOpen ? "primary_filled" : "primary",
      size: "medium",
      width: "fill",
      text: {
        tag: "plain_text",
        content: `${icon} ${s.project} — "${prompt}"`,
      },
      behaviors: [
        {
          type: "callback",
          value: {
            callback_data: `continue:${i}`,
            chatId,
          },
        },
      ],
    });
  }

  elements.push({ tag: "hr" });
  elements.push({
    tag: "markdown",
    content: "按钮文字 = 项目名 · 首条消息摘要",
    text_size: "notation",
  });

  return JSON.stringify({
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "Continue Session" },
      template: "turquoise",
      icon: { tag: "standard_icon", token: "history_filled" },
      padding: "12px 12px 12px 12px",
    },
    body: { elements },
  });
}
