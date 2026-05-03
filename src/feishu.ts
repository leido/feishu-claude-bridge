/**
 * Feishu Client — WebSocket event subscription + REST message sending.
 *
 * Uses @larksuiteoapi/node-sdk WSClient for real-time events and REST Client
 * for message operations. Renders responses via CardKit v2 streaming cards
 * with 3-layer send degradation (card → post → text).
 *
 * Card action callbacks require a WSClient monkey-patch because the SDK's
 * WSClient only handles type="event" messages; card callbacks arrive as
 * type="card" and would be silently dropped without the patch.
 */

import crypto from 'node:crypto';
import * as lark from '@larksuiteoapi/node-sdk';
import type {
  InboundMessage,
  FileAttachment,
  ToolCallInfo,
  TokenUsage,
  AppContext,
} from './types.js';
import {
  htmlToFeishuMarkdown,
  preprocessFeishuMarkdown,
  hasComplexMarkdown,
  buildCardContent,
  buildPostContent,
  buildStreamingContent,
  buildFinalCardJson,
  buildPermissionButtonCard,
  buildStreamingPermissionCard,
  buildPermResolvedStreamingCard,
  buildMultiQuestionCard,
  buildMultiQuestionStreamingCard,
  buildPlanApprovalCard,
  buildPlanApprovalResolvedCard,
  buildToolProgressMarkdown,
  formatElapsed,
  formatTokenCount,
  CARD_CONTENT_LIMIT,
} from './feishu-markdown.js';

const DEDUP_MAX = 1000;
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const TYPING_EMOJI = 'Typing';
const CARD_THROTTLE_MS = 200;

/** State for an active CardKit v2 streaming card. */
interface CardState {
  cardId: string;
  messageId: string;
  sequence: number;
  startTime: number;
  /** When the first card for this task was created (preserved across splits). */
  originalStartTime: number;
  toolCalls: ToolCallInfo[];
  thinking: boolean;
  pendingText: string | null;
  accumulatedContent: string;
  cycleCount: number;
  lastCycleStartAt: number;
  lastUpdateAt: number;
  throttleTimer: ReturnType<typeof setTimeout> | null;
}

type FeishuMessageEventData = {
  sender: {
    sender_id?: {
      open_id?: string;
      union_id?: string;
      user_id?: string;
    };
    sender_type: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    chat_id: string;
    chat_type: string;
    message_type: string;
    content: string;
    create_time: string;
    mentions?: Array<{
      key: string;
      id: { open_id?: string; union_id?: string; user_id?: string };
      name: string;
    }>;
  };
};

const MIME_BY_TYPE: Record<string, string> = {
  image: 'image/png',
  file: 'application/octet-stream',
  audio: 'audio/ogg',
  video: 'video/mp4',
  media: 'application/octet-stream',
};

export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export class FeishuClient {
  private config: AppContext['config'];
  private running = false;
  private queue: InboundMessage[] = [];
  private waiters: Array<(msg: InboundMessage | null) => void> = [];
  private wsClient: lark.WSClient | null = null;
  private restClient: lark.Client | null = null;
  private seenMessageIds = new Map<string, boolean>();
  private botOpenId: string | null = null;
  private botIds = new Set<string>();
  private lastIncomingMessageId = new Map<string, string>();
  private typingReactions = new Map<string, string>();
  private activeCards = new Map<string, CardState>();
  private cardCreatePromises = new Map<string, Promise<boolean>>();
  private permissionCardIds = new Map<string, {
    cardId: string;
    messageId: string;
    sequence: number;
    pendingText: string;
    toolCalls: ToolCallInfo[];
    accumulatedContent: string;
    cycleCount: number;
    lastCycleStartAt: number;
  }>();
  private resolvedPermissionChats = new Set<string>();

  constructor(config: AppContext['config']) {
    this.config = config;
  }

  // ── Lifecycle ───────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;

    const { feishuAppId, feishuAppSecret, feishuDomain } = this.config;
    if (!feishuAppId || !feishuAppSecret) {
      console.warn('[feishu] Cannot start: missing appId or appSecret');
      return;
    }

    const domain = feishuDomain === 'lark'
      ? lark.Domain.Lark
      : lark.Domain.Feishu;

    this.restClient = new lark.Client({
      appId: feishuAppId,
      appSecret: feishuAppSecret,
      domain,
    });

    await this.resolveBotIdentity(feishuAppId, feishuAppSecret, domain);

    this.running = true;

    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        await this.handleIncomingEvent(data as FeishuMessageEventData);
      },
      'card.action.trigger': (async (data: unknown) => {
        return await this.handleCardAction(data);
      }) as any,
    });

    this.wsClient = new lark.WSClient({
      appId: feishuAppId,
      appSecret: feishuAppSecret,
      domain,
    });

    // Monkey-patch WSClient.handleEventData to support card action events.
    // The SDK's WSClient only processes type="event" messages. Card action
    // callbacks arrive as type="card" and would be silently dropped.
    const wsAny = this.wsClient as any;
    if (typeof wsAny.handleEventData === 'function') {
      const origHandleEventData = wsAny.handleEventData.bind(wsAny);
      wsAny.handleEventData = (data: any) => {
        const msgType = data.headers?.find?.((h: any) => h.key === 'type')?.value;
        if (msgType === 'card') {
          console.log('[feishu] handleEventData type: card (patched → event)');
          const patchedData = {
            ...data,
            headers: data.headers.map((h: any) =>
              h.key === 'type' ? { ...h, value: 'event' } : h,
            ),
          };
          return origHandleEventData(patchedData);
        }
        return origHandleEventData(data);
      };
    }

    this.wsClient.start({ eventDispatcher: dispatcher });
    console.log('[feishu] Started (botOpenId:', this.botOpenId || 'unknown', ')');
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    // Finalize all active streaming cards before clearing restClient
    const finalizePromises: Promise<void>[] = [];
    for (const [chatId, state] of this.activeCards) {
      if (state.throttleTimer) clearTimeout(state.throttleTimer);
      try {
        const restClient = this.restClient;
        if (restClient) {
          state.sequence++;
          const seq1 = state.sequence;
          const cardId = state.cardId;
          const finalCardJson = buildFinalCardJson(state.accumulatedContent, state.pendingText || '', state.toolCalls, {
            status: '⚠️ Interrupted (restarting)',
            elapsed: formatElapsed(Date.now() - state.startTime),
          });
          finalizePromises.push(
            (restClient as any).cardkit.v1.card.settings({
              path: { card_id: cardId },
              data: { settings: JSON.stringify({ config: { streaming_mode: false } }), sequence: seq1 },
            }).then(() => {
              state.sequence++;
              return (restClient as any).cardkit.v1.card.update({
                path: { card_id: cardId },
                data: { card: { type: 'card_json', data: finalCardJson }, sequence: state.sequence },
              });
            }).catch(() => {})
          );
        }
      } catch { /* best effort */ }
    }
    await Promise.all(finalizePromises);
    this.activeCards.clear();

    if (this.wsClient) {
      try { this.wsClient.close({ force: true }); } catch { /* ignore */ }
      this.wsClient = null;
    }
    this.restClient = null;

    for (const waiter of this.waiters) {
      waiter(null);
    }
    this.waiters = [];
    this.cardCreatePromises.clear();
    this.permissionCardIds.clear();
    this.resolvedPermissionChats.clear();
    this.seenMessageIds.clear();
    this.lastIncomingMessageId.clear();
    this.typingReactions.clear();

    console.log('[feishu] Stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  // ── Queue ───────────────────────────────────────────────────

  consumeOne(): Promise<InboundMessage | null> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (!this.running) return Promise.resolve(null);
    return new Promise<InboundMessage | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private enqueue(msg: InboundMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(msg);
    } else {
      this.queue.push(msg);
    }
  }

  // ── Typing indicator ───────────────────────────────────────

  onMessageStart(chatId: string): void {
    const messageId = this.lastIncomingMessageId.get(chatId);
    if (messageId) {
      this.createStreamingCard(chatId, messageId).catch(() => {});
    }
    if (!messageId || !this.restClient) return;
    this.restClient.im.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: TYPING_EMOJI } },
    }).then((res) => {
      const reactionId = (res as any)?.data?.reaction_id;
      if (reactionId) {
        this.typingReactions.set(chatId, reactionId);
      }
    }).catch((err) => {
      const code = (err as { code?: number })?.code;
      if (code !== 99991400 && code !== 99991403) {
        console.warn('[feishu] Typing indicator failed:', err instanceof Error ? err.message : err);
      }
    });
  }

  onMessageEnd(chatId: string): void {
    this.cleanupCard(chatId);
    const reactionId = this.typingReactions.get(chatId);
    const messageId = this.lastIncomingMessageId.get(chatId);
    if (!reactionId || !messageId || !this.restClient) return;
    this.typingReactions.delete(chatId);
    this.restClient.im.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    }).catch(() => { /* ignore */ });
  }

  // ── Card Action Handler ────────────────────────────────────

  private async handleCardAction(data: unknown): Promise<unknown> {
    const FALLBACK_TOAST = { toast: { type: 'info' as const, content: '已收到' } };
    try {
      const event = data as any;
      const value = event?.action?.value ?? {};
      const callbackData = value.callback_data;
      if (!callbackData) return FALLBACK_TOAST;

      const chatId = event?.context?.open_chat_id || value.chatId || '';
      const messageId = event?.context?.open_message_id || event?.open_message_id || '';
      const userId = event?.operator?.open_id || event?.open_id || '';
      if (!chatId) return FALLBACK_TOAST;

      this.enqueue({
        messageId: messageId || `card_action_${Date.now()}`,
        chatId,
        userId,
        text: '',
        timestamp: Date.now(),
        callbackData,
        callbackMessageId: messageId,
      });

      return { toast: { type: 'info' as const, content: '已收到，正在处理...' } };
    } catch (err) {
      console.error('[feishu] Card action error:', err instanceof Error ? err.message : err);
      return FALLBACK_TOAST;
    }
  }

  // ── Streaming Card (CardKit v2) ────────────────────────────

  private createStreamingCard(chatId: string, replyToMessageId?: string): Promise<boolean> {
    if (!this.restClient || this.activeCards.has(chatId)) return Promise.resolve(false);
    const existing = this.cardCreatePromises.get(chatId);
    if (existing) return existing;

    const promise = this._doCreateStreamingCard(chatId, replyToMessageId);
    this.cardCreatePromises.set(chatId, promise);
    promise.finally(() => this.cardCreatePromises.delete(chatId));
    return promise;
  }

  private async _doCreateStreamingCard(chatId: string, replyToMessageId?: string): Promise<boolean> {
    if (!this.restClient) return false;

    try {
      const cardBody = {
        schema: '2.0',
        config: {
          streaming_mode: true,
          wide_screen_mode: true,
          summary: { content: '思考中...' },
        },
        body: {
          elements: [{
            tag: 'markdown',
            content: '💭 Thinking...',
            text_align: 'left',
            text_size: 'normal',
            element_id: 'streaming_content',
          }],
        },
      };

      const createResp = await (this.restClient as any).cardkit.v1.card.create({
        data: { type: 'card_json', data: JSON.stringify(cardBody) },
      });
      const cardId = createResp?.data?.card_id;
      if (!cardId) {
        console.warn('[feishu] Card create returned no card_id');
        return false;
      }

      const cardContent = JSON.stringify({ type: 'card', data: { card_id: cardId } });
      let msgResp;
      if (replyToMessageId) {
        msgResp = await this.restClient.im.message.reply({
          path: { message_id: replyToMessageId },
          data: { content: cardContent, msg_type: 'interactive' },
        });
      } else {
        msgResp = await this.restClient.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'interactive',
            content: cardContent,
          },
        });
      }

      const messageId = msgResp?.data?.message_id;
      if (!messageId) {
        console.warn('[feishu] Card message send returned no message_id');
        return false;
      }

      const now = Date.now();
      this.activeCards.set(chatId, {
        cardId,
        messageId,
        sequence: 0,
        startTime: now,
        originalStartTime: now,
        toolCalls: [],
        thinking: true,
        pendingText: null,
        accumulatedContent: '',
        cycleCount: 0,
        lastCycleStartAt: now,
        lastUpdateAt: 0,
        throttleTimer: null,
      });

      console.log(`[feishu] Streaming card created: cardId=${cardId}, msgId=${messageId}`);
      return true;
    } catch (err) {
      console.warn('[feishu] Failed to create streaming card:', err instanceof Error ? err.message : err);
      return false;
    }
  }

  private updateCardContent(chatId: string, text: string): void {
    const state = this.activeCards.get(chatId);
    if (!state || !this.restClient) return;

    if (state.thinking && text.trim()) {
      state.thinking = false;
    }
    state.pendingText = text;

    const elapsed = Date.now() - state.lastUpdateAt;
    if (elapsed < CARD_THROTTLE_MS && state.lastUpdateAt > 0) {
      if (!state.throttleTimer) {
        state.throttleTimer = setTimeout(() => {
          state.throttleTimer = null;
          this.flushCardUpdate(chatId);
        }, CARD_THROTTLE_MS - elapsed);
      }
      return;
    }

    if (state.throttleTimer) {
      clearTimeout(state.throttleTimer);
      state.throttleTimer = null;
    }
    this.flushCardUpdate(chatId);
  }

  private flushCardUpdate(chatId: string): void {
    const state = this.activeCards.get(chatId);
    if (!state || !this.restClient) return;

    const content = buildStreamingContent(state.accumulatedContent, state.pendingText || '', state.toolCalls);

    // Auto-split if content exceeds limit and we have accumulated content to split on
    if (content.length > CARD_CONTENT_LIMIT && state.accumulatedContent.length > 0) {
      this.splitCard(chatId);
      return;
    }

    state.sequence++;
    const seq = state.sequence;
    const cardId = state.cardId;

    (this.restClient as any).cardkit.v1.cardElement.content({
      path: { card_id: cardId, element_id: 'streaming_content' },
      data: { content, sequence: seq },
    }).then(() => {
      state.lastUpdateAt = Date.now();
    }).catch((err: unknown) => {
      console.warn('[feishu] streamContent failed:', err instanceof Error ? err.message : err);
    });
  }

  private updateToolProgress(chatId: string, tools: ToolCallInfo[]): void {
    if (!this.activeCards.has(chatId)) {
      const messageId = this.lastIncomingMessageId.get(chatId);
      this.createStreamingCard(chatId, messageId).then((ok) => {
        if (ok) {
          const s = this.activeCards.get(chatId);
          if (s) {
            s.toolCalls = tools;
            this.updateCardContent(chatId, '');
          }
        }
      }).catch(() => {});
      return;
    }
    const state = this.activeCards.get(chatId);
    if (!state) return;
    // Preserve existing tool calls not in the incoming list
    const existing = state.toolCalls.filter((tc) => !tools.some((t) => t.id === tc.id));
    // Preserve approved flag from existing tool calls
    const merged = tools.map((tc) => {
      const prev = state.toolCalls.find((p) => p.id === tc.id);
      if (prev?.approved) {
        return { ...tc, approved: true };
      }
      if (prev?.error && !tc.error) {
        return { ...tc, error: prev.error };
      }
      return tc;
    });
    state.toolCalls = [...existing, ...merged];
    this.updateCardContent(chatId, state.pendingText || '');
  }

  onToolEvent(chatId: string, toolId: string, toolName: string, status: 'running' | 'complete' | 'error', input?: Record<string, unknown>, error?: string): void {
    const tools: ToolCallInfo[] = [];
    if (toolName) {
      tools.push({ id: toolId, name: toolName, status, input, error });
    } else {
      // Status-only update — get existing tool name
      const state = this.activeCards.get(chatId);
      const existing = state?.toolCalls.find((tc) => tc.id === toolId);
      if (existing) {
        existing.status = status;
        if (error) existing.error = error;
        this.updateCardContent(chatId, state?.pendingText || '');
        return;
      }
    }
    this.updateToolProgress(chatId, tools);
  }

  async finalizeCard(
    chatId: string,
    status: 'completed' | 'interrupted' | 'error',
    responseText: string,
    tokenUsage?: TokenUsage | null,
  ): Promise<boolean> {
    const pending = this.cardCreatePromises.get(chatId);
    if (pending) {
      try { await pending; } catch { /* no card */ }
    }

    const state = this.activeCards.get(chatId);
    if (!state || !this.restClient) return false;

    // Immediately release so a new card can be created for the next cycle
    this.activeCards.delete(chatId);

    if (state.throttleTimer) {
      clearTimeout(state.throttleTimer);
      state.throttleTimer = null;
    }

    try {
      state.sequence++;
      await (this.restClient as any).cardkit.v1.card.settings({
        path: { card_id: state.cardId },
        data: {
          settings: JSON.stringify({ config: { streaming_mode: false } }),
          sequence: state.sequence,
        },
      });

      const statusLabels: Record<string, string> = {
        completed: '✅ Completed',
        interrupted: '⚠️ Interrupted',
        error: '❌ Error',
      };
      const elapsedMs = Date.now() - state.originalStartTime;
      const footer: { status: string; elapsed: string; tokens?: string; cost?: string; context?: string } = {
        status: statusLabels[status] || status,
        elapsed: formatElapsed(elapsedMs),
      };

      if (tokenUsage) {
        const inTok = tokenUsage.input_tokens ?? 0;
        const outTok = tokenUsage.output_tokens ?? 0;
        const cacheTok = (tokenUsage.cache_read_input_tokens ?? 0) + (tokenUsage.cache_creation_input_tokens ?? 0);
        footer.tokens = cacheTok > 0
          ? `↓${formatTokenCount(inTok)} ↑${formatTokenCount(outTok)} (cache ${formatTokenCount(cacheTok)})`
          : `↓${formatTokenCount(inTok)} ↑${formatTokenCount(outTok)}`;
        if (tokenUsage.cost_usd != null) {
          footer.cost = `$${tokenUsage.cost_usd.toFixed(4)}`;
        }
        const totalTokens = inTok + outTok;
        const CONTEXT_WINDOW_TOKENS = 200_000; // Claude Sonnet 4 context window
        const contextPct = (totalTokens / CONTEXT_WINDOW_TOKENS * 100).toFixed(1);
        footer.context = `${contextPct}%`;
      }

      const finalCardJson = buildFinalCardJson(state.accumulatedContent, responseText, state.toolCalls, footer);
      state.sequence++;
      await (this.restClient as any).cardkit.v1.card.update({
        path: { card_id: state.cardId },
        data: {
          card: { type: 'card_json', data: finalCardJson },
          sequence: state.sequence,
        },
      });

      console.log(`[feishu] Card finalized: cardId=${state.cardId}, status=${status}, elapsed=${formatElapsed(elapsedMs)}`);
      return true;
    } catch (err: any) {
      const fv = err?.response?.data?.field_violations;
      if (fv) {
        console.warn('[feishu] Card finalize field violations:', JSON.stringify(fv));
      }
      console.warn('[feishu] Card finalize failed:', err instanceof Error ? err.message : err);
      return false;
    }
  }

  private cleanupCard(chatId: string): void {
    this.cardCreatePromises.delete(chatId);
    const state = this.activeCards.get(chatId);
    if (!state) return;
    if (state.throttleTimer) clearTimeout(state.throttleTimer);
    this.activeCards.delete(chatId);
  }

  hasActiveCard(chatId: string): boolean {
    return this.activeCards.has(chatId);
  }

  /** Return the underlying WebSocket readyState (1 = OPEN), or null if no instance. */
  getWsReadyState(): number | null {
    const ws = (this.wsClient as any)?.wsConfig?.getWSInstance?.();
    return ws?.readyState ?? null;
  }

  // ── Streaming adapter interface ────────────────────────────

  onStreamText(chatId: string, fullText: string): void {
    if (!this.activeCards.has(chatId)) {
      const messageId = this.lastIncomingMessageId.get(chatId);
      this.createStreamingCard(chatId, messageId).then((ok) => {
        if (ok) this.updateCardContent(chatId, fullText);
      }).catch(() => {});
      return;
    }
    this.updateCardContent(chatId, fullText);
  }

  async onStreamEnd(
    chatId: string,
    status: 'completed' | 'interrupted' | 'error',
    responseText: string,
    tokenUsage?: TokenUsage | null,
  ): Promise<boolean> {
    return this.finalizeCard(chatId, status, responseText, tokenUsage);
  }

  /**
   * Called when a tool-use cycle completes.
   * Snapshots completed tools into accumulated content and appends a cycle marker.
   */
  onCycleComplete(chatId: string): void {
    const state = this.activeCards.get(chatId);
    if (!state) return;

    const hadContent = (state.pendingText && state.pendingText.trim()) || state.toolCalls.length > 0;

    // Snapshot current text into accumulated content (blank line between)
    if (state.pendingText && state.pendingText.trim()) {
      state.accumulatedContent = state.accumulatedContent
        ? `${state.accumulatedContent}\n\n${state.pendingText}`
        : state.pendingText;
    }

    // Snapshot completed tools into accumulated content (single newline)
    if (state.toolCalls.length > 0) {
      const toolMd = buildToolProgressMarkdown(state.toolCalls);
      if (toolMd) {
        state.accumulatedContent = state.accumulatedContent
          ? `${state.accumulatedContent}\n${toolMd}`
          : toolMd;
      }
    }

    // Append elapsed time only if this cycle had content
    if (hadContent) {
      state.cycleCount++;
      const elapsed = Date.now() - state.lastCycleStartAt;
      state.accumulatedContent = state.accumulatedContent
        ? `${state.accumulatedContent} (${formatElapsed(elapsed)})`
        : `(${formatElapsed(elapsed)})`;
    }

    // Clear for next cycle
    state.toolCalls = [];
    state.pendingText = null;
    state.lastCycleStartAt = Date.now();

    // Trigger visual update to show the marker
    this.updateCardContent(chatId, '');
  }

  /**
   * Split the current card when content exceeds the size limit.
   * Finalizes current card with "(continued)" footer and creates a new one.
   */
  private async splitCard(chatId: string): Promise<void> {
    const state = this.activeCards.get(chatId);
    if (!state || !this.restClient) return;

    // Save state before finalization
    const savedCycleCount = state.cycleCount;
    const savedPendingText = state.pendingText;
    const savedToolCalls = [...state.toolCalls];
    const savedContent = state.accumulatedContent;
    const savedOriginalStartTime = state.originalStartTime;

    // Finalize current card with "(continued)" footer
    this.activeCards.delete(chatId);
    if (state.throttleTimer) {
      clearTimeout(state.throttleTimer);
      state.throttleTimer = null;
    }

    try {
      state.sequence++;
      await (this.restClient as any).cardkit.v1.card.settings({
        path: { card_id: state.cardId },
        data: {
          settings: JSON.stringify({ config: { streaming_mode: false } }),
          sequence: state.sequence,
        },
      });

      const continuationCard = JSON.stringify({
        schema: '2.0',
        config: { wide_screen_mode: true },
        body: {
          elements: [
            { tag: 'markdown', content: preprocessFeishuMarkdown(savedContent), text_align: 'left', text_size: 'normal' },
            { tag: 'hr' },
            { tag: 'markdown', content: '*... continued in next card*', text_size: 'notation' },
          ],
        },
      });

      state.sequence++;
      await (this.restClient as any).cardkit.v1.card.update({
        path: { card_id: state.cardId },
        data: {
          card: { type: 'card_json', data: continuationCard },
          sequence: state.sequence,
        },
      });

      console.log(`[feishu] Card split: cardId=${state.cardId}, contentLen=${savedContent.length}`);
    } catch (err) {
      console.warn('[feishu] Continuation card finalize failed:', err instanceof Error ? err.message : err);
    }

    // Create new streaming card for remaining content
    const msgId = this.lastIncomingMessageId.get(chatId);
    if (msgId) {
      const created = await this.createStreamingCard(chatId, msgId);
      if (created) {
        const newState = this.activeCards.get(chatId);
        if (newState) {
          newState.cycleCount = savedCycleCount;
          newState.pendingText = savedPendingText;
          newState.toolCalls = savedToolCalls;
          newState.accumulatedContent = '';
          newState.originalStartTime = savedOriginalStartTime;
          if (savedPendingText || savedToolCalls.length > 0) {
            this.updateCardContent(chatId, savedPendingText || '');
          }
        }
      }
    }
  }

  // ── Send (3-layer degradation) ─────────────────────────────

  async send(
    chatId: string,
    text: string,
    parseMode?: string,
    replyToMessageId?: string,
  ): Promise<SendResult> {
    if (!this.restClient) {
      return { ok: false, error: 'Feishu client not initialized' };
    }

    if (parseMode === 'HTML') {
      text = htmlToFeishuMarkdown(text);
    }
    if (parseMode === 'Markdown') {
      text = preprocessFeishuMarkdown(text);
    }

    if (hasComplexMarkdown(text)) {
      return this.sendAsCard(chatId, text, replyToMessageId);
    }
    return this.sendAsPost(chatId, text, replyToMessageId);
  }

  private async sendAsCard(chatId: string, text: string, replyToMessageId?: string): Promise<SendResult> {
    const cardContent = buildCardContent(text);

    try {
      let res;
      if (replyToMessageId) {
        res = await this.restClient!.im.message.reply({
          path: { message_id: replyToMessageId },
          data: { content: cardContent, msg_type: 'interactive' },
        });
      } else {
        res = await this.restClient!.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: 'interactive', content: cardContent },
        });
      }
      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      console.warn('[feishu] Card send failed:', res?.msg, res?.code);
    } catch (err) {
      console.warn('[feishu] Card send error, falling back to post:', err instanceof Error ? err.message : err);
    }

    return this.sendAsPost(chatId, text, replyToMessageId);
  }

  private async sendAsPost(chatId: string, text: string, replyToMessageId?: string): Promise<SendResult> {
    const postContent = buildPostContent(text);

    try {
      let res;
      if (replyToMessageId) {
        res = await this.restClient!.im.message.reply({
          path: { message_id: replyToMessageId },
          data: { content: postContent, msg_type: 'post' },
        });
      } else {
        res = await this.restClient!.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: 'post', content: postContent },
        });
      }
      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      console.warn('[feishu] Post send failed:', res?.msg, res?.code);
    } catch (err) {
      console.warn('[feishu] Post send error, falling back to text:', err instanceof Error ? err.message : err);
    }

    // Final fallback: plain text
    try {
      let res;
      if (replyToMessageId) {
        res = await this.restClient!.im.message.reply({
          path: { message_id: replyToMessageId },
          data: { content: JSON.stringify({ text }), msg_type: 'text' },
        });
      } else {
        res = await this.restClient!.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) },
        });
      }
      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      return { ok: false, error: res?.msg || 'Send failed' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Send failed' };
    }
  }

  // ── Permission Card ────────────────────────────────────────

  /**
   * Embed permission buttons into the active streaming card.
   * Returns the card's messageId if successful, null otherwise.
   */
  private async embedPermissionInActiveCard(
    chatId: string,
    permMdText: string,
    permissionRequestId: string,
    suggestions?: unknown[],
    multiQuestionData?: { questions: Array<{ question?: string; header?: string; options?: Array<{ label?: string; description?: string }>; multiSelect?: boolean }> },
  ): Promise<SendResult | null> {
    // Wait for any in-flight card creation before checking activeCards
    const pending = this.cardCreatePromises.get(chatId);
    if (pending) {
      console.log(`[feishu] embedPerm: awaiting cardCreatePromise for ${chatId}`);
      try { await pending; } catch { /* no card */ }
    }

    const state = this.activeCards.get(chatId);
    if (!state || !this.restClient) {
      console.log(`[feishu] embedPerm: no active card for ${chatId} (hasCard=${!!state}, hasRest=${!!this.restClient})`);
      return null;
    }
    console.log(`[feishu] embedPerm: found active card ${state.cardId} for ${chatId}`);

    // Remove from activeCards immediately so new cards can be created after approval
    this.activeCards.delete(chatId);
    if (state.throttleTimer) {
      clearTimeout(state.throttleTimer);
      state.throttleTimer = null;
    }

    try {
      // Disable streaming mode
      state.sequence++;
      await (this.restClient as any).cardkit.v1.card.settings({
        path: { card_id: state.cardId },
        data: {
          settings: JSON.stringify({ config: { streaming_mode: false } }),
          sequence: state.sequence,
        },
      });

      // Build card: use multi-question layout if applicable
      let cardJson: string;
      if (multiQuestionData && multiQuestionData.questions.length > 1) {
        cardJson = buildMultiQuestionStreamingCard(
          state.accumulatedContent,
          state.pendingText || '',
          state.toolCalls,
          permMdText,
          permissionRequestId,
          chatId,
          multiQuestionData.questions,
          new Map(),
        );
      } else {
        cardJson = buildStreamingPermissionCard(
          state.accumulatedContent,
          state.pendingText || '',
          state.toolCalls,
          permMdText,
          permissionRequestId,
          chatId,
          suggestions,
        );
      }
      state.sequence++;
      await (this.restClient as any).cardkit.v1.card.update({
        path: { card_id: state.cardId },
        data: {
          card: { type: 'card_json', data: cardJson },
          sequence: state.sequence,
        },
      });

      console.log(`[feishu] Permission embedded in streaming card: cardId=${state.cardId}`);
      // Track card for later resolution update
      this.permissionCardIds.set(permissionRequestId, {
        cardId: state.cardId,
        messageId: state.messageId,
        sequence: state.sequence,
        pendingText: state.pendingText || '',
        toolCalls: [...state.toolCalls],
        accumulatedContent: state.accumulatedContent,
        cycleCount: state.cycleCount,
        lastCycleStartAt: state.lastCycleStartAt,
      });
      return { ok: true, messageId: state.messageId };
    } catch (err) {
      console.warn('[feishu] Failed to embed permission in streaming card:', err instanceof Error ? err.message : err);
      return null;
    }
  }

  /**
   * Send a dedicated plan approval card for ExitPlanMode.
   * Finalizes the current streaming card (without plan text), then creates
   * a new card with the plan content and approval buttons.
   */
  private async sendPlanApprovalCard(
    chatId: string,
    permMdText: string,
    permissionRequestId: string,
    replyToMessageId?: string,
    suggestions?: unknown[],
    toolInput?: Record<string, unknown>,
  ): Promise<SendResult> {
    // Extract plan text from ExitPlanMode input
    const planText = toolInput?.plan ? String(toolInput.plan) : '';
    const state = this.activeCards.get(chatId);
    if (state) {
      // Remove ExitPlanMode from tool calls before finalizing (it's shown in the new approval card)
      state.toolCalls = state.toolCalls.filter((tc) => tc.name.toLowerCase() !== 'exitplanmode');
      // Finalize current card WITHOUT plan text (just tool progress + footer)
      await this.finalizeCard(chatId, 'completed', '', null).catch((err: unknown) => {
        console.warn('[feishu] Plan card finalize failed:', err instanceof Error ? err.message : err);
      });
    }

    // Build and send dedicated plan approval card
    const cardJson = buildPlanApprovalCard(planText, permMdText, permissionRequestId, chatId, suggestions);

    try {
      let res;
      if (replyToMessageId) {
        res = await (this.restClient as any).im.message.reply({
          path: { message_id: replyToMessageId },
          data: { content: cardJson, msg_type: 'interactive' },
        });
      } else {
        res = await (this.restClient as any).im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: 'interactive', content: cardJson },
        });
      }

      if (res?.data?.message_id) {
        const messageId = res.data.message_id;
        // Extract card_id from interactive message for tracking
        let cardId = '';
        try {
          const msgData = typeof res.data?.content === 'string' ? JSON.parse(res.data.content) : res.data;
          cardId = msgData?.card_id ?? res.data?.card_id ?? '';
        } catch { /* no card_id */ }

        if (!cardId) {
          // Try to find card_id via message resource
          try {
            const msgRes = await (this.restClient as any).im.message.get({ path: { message_id: messageId } });
            cardId = msgRes?.data?.items?.[0]?.card_id ?? '';
          } catch { /* no card_id */ }
        }

        console.log(`[feishu] Plan approval card sent: cardId=${cardId}, planTextLen=${planText.length}`);

        // Track for later resolution
        this.permissionCardIds.set(permissionRequestId, {
          cardId: cardId || messageId,
          messageId,
          sequence: 0,
          pendingText: planText,
          toolCalls: [],
          accumulatedContent: '',
          cycleCount: 0,
          lastCycleStartAt: Date.now(),
        });

        return { ok: true, messageId };
      }
      console.warn('[feishu] Plan approval card send failed:', res?.msg);
    } catch (err) {
      console.warn('[feishu] Plan approval card error:', err instanceof Error ? err.message : err);
    }

    return { ok: false, error: 'Failed to send plan approval card' };
  }

  async sendPermissionCard(
    chatId: string,
    mdText: string,
    permissionRequestId: string,
    replyToMessageId?: string,
    suggestions?: unknown[],
    multiQuestionData?: { questions: Array<{ question?: string; header?: string; options?: Array<{ label?: string; description?: string }>; multiSelect?: boolean }> },
    toolName?: string,
    toolInput?: Record<string, unknown>,
  ): Promise<SendResult> {
    if (!this.restClient) {
      return { ok: false, error: 'Feishu client not initialized' };
    }

    // ExitPlanMode: dedicated plan approval card
    if (toolName?.toLowerCase() === 'exitplanmode') {
      return this.sendPlanApprovalCard(chatId, mdText, permissionRequestId, replyToMessageId, suggestions, toolInput);
    }

    // Default: try to embed permission into the active streaming card first
    let embedded = await this.embedPermissionInActiveCard(chatId, mdText, permissionRequestId, suggestions, multiQuestionData);
    if (!embedded) {
      // No active card — create one and retry embedding
      const msgId = replyToMessageId || this.lastIncomingMessageId.get(chatId);
      console.log(`[feishu] sendPermCard: embed failed, creating new card (msgId=${!!msgId})`);
      if (msgId) {
        await this.createStreamingCard(chatId, msgId);
        embedded = await this.embedPermissionInActiveCard(chatId, mdText, permissionRequestId, suggestions, multiQuestionData);
      }
    }
    if (embedded) return embedded;

    // Fallback: send as a separate card
    let cardJson: string;
    if (multiQuestionData && multiQuestionData.questions.length > 1) {
      cardJson = buildMultiQuestionCard(mdText, permissionRequestId, chatId, multiQuestionData.questions, new Map());
    } else {
      cardJson = buildPermissionButtonCard(mdText, permissionRequestId, chatId, suggestions);
    }

    try {
      let res;
      if (replyToMessageId) {
        res = await this.restClient.im.message.reply({
          path: { message_id: replyToMessageId },
          data: { content: cardJson, msg_type: 'interactive' },
        });
      } else {
        res = await this.restClient.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: 'interactive', content: cardJson },
        });
      }
      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      console.warn('[feishu] Permission card send failed:', res?.msg);
    } catch (err) {
      console.warn('[feishu] Permission card error, falling back to text:', err instanceof Error ? err.message : err);
    }

    // Final fallback: plain text
    const plainText = [
      mdText,
      '',
      '---',
      'Reply: 1 = Allow once | 2 = Allow session | 3 = Deny',
    ].join('\n');

    try {
      const res = await this.restClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: plainText }) },
      });
      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      return { ok: false, error: res?.msg || 'Send failed' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Send failed' };
    }
  }

  /**
   * Update a permission card to show resolved status (Allowed/Denied).
   * Re-enables streaming and re-adds to activeCards so continuation text
   * flows into the same card instead of creating a duplicate.
   *
   * When `finalize` is true, the card is finalized (streaming disabled, footer
   * added) and NOT re-added to activeCards. This is used for ExitPlanMode so
   * subsequent execution text starts in a fresh card.
   */
  async resolvePermissionCard(
    permissionRequestId: string,
    action: 'allow' | 'deny',
    chatId: string,
    options?: { finalize?: boolean },
  ): Promise<boolean> {
    const tracked = this.permissionCardIds.get(permissionRequestId);
    if (!tracked || !this.restClient) {
      console.log(`[feishu] resolvePermCard: no tracked card for ${permissionRequestId} (tracked=${!!tracked})`);
      return false;
    }
    this.permissionCardIds.delete(permissionRequestId);
    console.log(`[feishu] resolvePermCard: updating card ${tracked.cardId}, action=${action}, finalize=${!!options?.finalize}, textLen=${tracked.pendingText.length}, tools=${tracked.toolCalls.length}`);

    try {
      // Update tool call status: matching tool → ✅/❌, others keep their state
      const updatedTools = tracked.toolCalls.map((tc) => {
        if (tc.id === permissionRequestId) {
          if (action === 'allow') {
            return { ...tc, status: 'complete' as const, approved: true };
          }
          return { ...tc, status: 'error' as const, denied: true };
        }
        return tc;
      });

      if (options?.finalize) {
        // Plan approval card resolve: update with approved/denied status
        const planText = tracked.pendingText || '';
        const resolvedCardJson = buildPlanApprovalResolvedCard(planText, action);
        tracked.sequence++;
        try {
          await (this.restClient as any).cardkit.v1.card.update({
            path: { card_id: tracked.cardId },
            data: {
              card: { type: 'card_json', data: resolvedCardJson },
              sequence: tracked.sequence,
            },
          });
        } catch {
          // CardKit update may fail if cardId is a messageId; try message update instead
          try {
            await (this.restClient as any).im.message.patch({
              path: { message_id: tracked.messageId },
              data: { content: resolvedCardJson },
            });
          } catch (err2) {
            console.warn('[feishu] Plan card resolve update failed:', err2 instanceof Error ? err2.message : err2);
          }
        }

        console.log(`[feishu] Plan approval card resolved: cardId=${tracked.cardId}, action=${action}`);
        return true;
      }

      // Normal mode: build card with resolved status but keep streaming_mode enabled
      // so continuation text updates this same card
      const cardJson = buildPermResolvedStreamingCard(
        tracked.accumulatedContent,
        tracked.pendingText,
        updatedTools,
        '',
        action,
      );

      tracked.sequence++;
      await (this.restClient as any).cardkit.v1.card.update({
        path: { card_id: tracked.cardId },
        data: {
          card: { type: 'card_json', data: cardJson },
          sequence: tracked.sequence,
        },
      });

      // Re-add to activeCards so continuation text streams here instead of creating a new card
      const now = Date.now();
      this.activeCards.set(chatId, {
        cardId: tracked.cardId,
        messageId: tracked.messageId,
        sequence: tracked.sequence,
        startTime: now,
        originalStartTime: now,
        toolCalls: updatedTools,
        thinking: false,
        pendingText: tracked.pendingText || null,
        accumulatedContent: tracked.accumulatedContent,
        cycleCount: tracked.cycleCount,
        lastCycleStartAt: tracked.lastCycleStartAt,
        lastUpdateAt: Date.now(),
        throttleTimer: null,
      });

      console.log(`[feishu] Permission card resolved & reactivated: cardId=${tracked.cardId}, action=${action}`);
      return true;
    } catch (err) {
      console.warn('[feishu] Failed to update permission card resolved state:', err instanceof Error ? err.message : err);
      return false;
    }
  }

  /** Update a multi-question permission card with current answer state. */
  async updateMultiQuestionCard(
    permissionRequestId: string,
    questions: Array<{ question?: string; header?: string; options?: Array<{ label?: string; description?: string }>; multiSelect?: boolean }>,
    answers: Map<number, number>,
    chatId: string,
  ): Promise<boolean> {
    const tracked = this.permissionCardIds.get(permissionRequestId);
    if (!tracked || !this.restClient) return false;

    try {
      const cardJson = buildMultiQuestionStreamingCard(
        tracked.accumulatedContent,
        tracked.pendingText,
        tracked.toolCalls,
        '',
        permissionRequestId,
        chatId,
        questions,
        answers,
      );
      tracked.sequence++;
      await (this.restClient as any).cardkit.v1.card.update({
        path: { card_id: tracked.cardId },
        data: { card: { type: 'card_json', data: cardJson }, sequence: tracked.sequence },
      });
      return true;
    } catch (err) {
      console.warn('[feishu] Failed to update multi-question card:', err instanceof Error ? err.message : err);
      return false;
    }
  }

  /** Check if a permission card was resolved for this chat (consumes the flag). */
  consumePermissionResolved(chatId: string): boolean {
    return this.resolvedPermissionChats.delete(chatId);
  }

  // ── Authorization ──────────────────────────────────────────

  isAuthorized(userId: string, chatId: string): boolean {
    const allowed = this.config.feishuAllowedUsers;
    if (!allowed || allowed.length === 0) return true;
    return allowed.includes(userId) || allowed.includes(chatId);
  }

  // ── Incoming event handler ─────────────────────────────────

  private async handleIncomingEvent(data: FeishuMessageEventData): Promise<void> {
    try {
      await this.processIncomingEvent(data);
    } catch (err) {
      console.error(
        '[feishu] Unhandled error in event handler:',
        err instanceof Error ? err.stack || err.message : err,
      );
    }
  }

  private async processIncomingEvent(data: FeishuMessageEventData): Promise<void> {
    const msg = data.message;
    const sender = data.sender;

    // Filter out bot messages
    if (sender.sender_type === 'bot') return;

    // Dedup
    if (this.seenMessageIds.has(msg.message_id)) return;
    this.addToDedup(msg.message_id);

    const chatId = msg.chat_id;
    const userId = sender.sender_id?.open_id
      || sender.sender_id?.user_id
      || sender.sender_id?.union_id
      || '';
    const isGroup = msg.chat_type === 'group';

    // Authorization
    if (!this.isAuthorized(userId, chatId)) {
      console.warn('[feishu] Unauthorized:', userId, chatId);
      return;
    }

    // Group chat: require @mention by default
    if (isGroup) {
      if (this.config.feishuRequireMention && !this.isBotMentioned(msg.mentions)) {
        console.log('[feishu] Group message ignored (bot not @mentioned), chatId:', chatId);
        return;
      }
    }

    // Track last message ID for typing indicator
    this.lastIncomingMessageId.set(chatId, msg.message_id);

    // Extract content based on message type
    let text = '';
    const attachments: FileAttachment[] = [];
    const messageType = msg.message_type;

    if (messageType === 'text') {
      text = this.parseTextContent(msg.content);
    } else if (messageType === 'image') {
      const fileKey = this.extractFileKey(msg.content);
      if (fileKey) {
        const attachment = await this.downloadResource(msg.message_id, fileKey, 'image');
        if (attachment) {
          attachments.push(attachment);
        } else {
          text = '[image download failed]';
        }
      }
    } else if (messageType === 'file' || messageType === 'audio' || messageType === 'video' || messageType === 'media') {
      const fileKey = this.extractFileKey(msg.content);
      if (fileKey) {
        const resourceType = messageType === 'audio' || messageType === 'video' || messageType === 'media'
          ? messageType
          : 'file';
        const attachment = await this.downloadResource(msg.message_id, fileKey, resourceType);
        if (attachment) {
          attachments.push(attachment);
        } else {
          text = `[${messageType} download failed]`;
        }
      }
    } else if (messageType === 'post') {
      const { extractedText, imageKeys } = this.parsePostContent(msg.content);
      text = extractedText;
      for (const key of imageKeys) {
        const attachment = await this.downloadResource(msg.message_id, key, 'image');
        if (attachment) attachments.push(attachment);
      }
    } else {
      console.log(`[feishu] Unsupported message type: ${messageType}, msgId: ${msg.message_id}`);
      return;
    }

    // Strip @mention markers
    text = this.stripMentionMarkers(text);

    if (!text.trim() && attachments.length === 0) return;

    const timestamp = parseInt(msg.create_time, 10) || Date.now();

    // Check for /perm text command
    const trimmedText = text.trim();
    if (trimmedText.startsWith('/perm ')) {
      const permParts = trimmedText.split(/\s+/);
      if (permParts.length >= 3) {
        const action = permParts[1];
        const permId = permParts.slice(2).join(' ');
        this.enqueue({
          messageId: msg.message_id,
          chatId,
          userId,
          text: trimmedText,
          timestamp,
          callbackData: `perm:${action}:${permId}`,
        });
        return;
      }
    }

    this.enqueue({
      messageId: msg.message_id,
      chatId,
      userId,
      text: text.trim(),
      timestamp,
      attachments: attachments.length > 0 ? attachments : undefined,
    });
  }

  // ── Content parsing ────────────────────────────────────────

  private parseTextContent(content: string): string {
    try {
      const parsed = JSON.parse(content);
      return parsed.text || '';
    } catch {
      return content;
    }
  }

  private extractFileKey(content: string): string | null {
    try {
      const parsed = JSON.parse(content);
      return parsed.image_key || parsed.file_key || parsed.imageKey || parsed.fileKey || null;
    } catch {
      return null;
    }
  }

  private parsePostContent(content: string): { extractedText: string; imageKeys: string[] } {
    const imageKeys: string[] = [];
    const textParts: string[] = [];

    try {
      const parsed = JSON.parse(content);
      if (parsed.title) textParts.push(parsed.title);

      const paragraphs = parsed.content;
      if (Array.isArray(paragraphs)) {
        for (const paragraph of paragraphs) {
          if (!Array.isArray(paragraph)) continue;
          for (const element of paragraph) {
            if (element.tag === 'text' && element.text) {
              textParts.push(element.text);
            } else if (element.tag === 'a' && element.text) {
              textParts.push(element.text);
            } else if (element.tag === 'img') {
              const key = element.image_key || element.file_key || element.imageKey;
              if (key) imageKeys.push(key);
            }
          }
          textParts.push('\n');
        }
      }
    } catch { /* parse error */ }

    return { extractedText: textParts.join('').trim(), imageKeys };
  }

  // ── Bot identity ───────────────────────────────────────────

  private async resolveBotIdentity(
    appId: string,
    appSecret: string,
    domain: lark.Domain,
  ): Promise<void> {
    try {
      const baseUrl = domain === lark.Domain.Lark
        ? 'https://open.larksuite.com'
        : 'https://open.feishu.cn';

      const tokenRes = await fetch(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
        signal: AbortSignal.timeout(10_000),
      });
      const tokenData: any = await tokenRes.json();
      if (!tokenData.tenant_access_token) {
        console.warn('[feishu] Failed to get tenant access token');
        return;
      }

      const botRes = await fetch(`${baseUrl}/open-apis/bot/v3/info/`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${tokenData.tenant_access_token}` },
        signal: AbortSignal.timeout(10_000),
      });
      const botData: any = await botRes.json();
      if (botData?.bot?.open_id) {
        this.botOpenId = botData.bot.open_id;
        this.botIds.add(botData.bot.open_id);
      }
      if (botData?.bot?.bot_id) {
        this.botIds.add(botData.bot.bot_id);
      }
      if (!this.botOpenId) {
        console.warn('[feishu] Could not resolve bot open_id');
      }
    } catch (err) {
      console.warn('[feishu] Failed to resolve bot identity:', err instanceof Error ? err.message : err);
    }
  }

  // ── @Mention detection ─────────────────────────────────────

  private isBotMentioned(
    mentions?: FeishuMessageEventData['message']['mentions'],
  ): boolean {
    if (!mentions || this.botIds.size === 0) return false;
    return mentions.some((m) => {
      const ids = [m.id.open_id, m.id.user_id, m.id.union_id].filter(Boolean) as string[];
      return ids.some((id) => this.botIds.has(id));
    });
  }

  private stripMentionMarkers(text: string): string {
    return text.replace(/@_user_\d+/g, '').trim();
  }

  // ── Resource download ──────────────────────────────────────

  private async downloadResource(
    messageId: string,
    fileKey: string,
    resourceType: string,
  ): Promise<FileAttachment | null> {
    if (!this.restClient) return null;

    try {
      const res = await this.restClient.im.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type: resourceType === 'image' ? 'image' : 'file' },
      });

      if (!res) return null;

      let buffer: Buffer;
      try {
        const readable = res.getReadableStream();
        const chunks: Buffer[] = [];
        let totalSize = 0;
        for await (const chunk of readable) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalSize += buf.length;
          if (totalSize > MAX_FILE_SIZE) {
            console.warn(`[feishu] Resource too large (>${MAX_FILE_SIZE}), key: ${fileKey}`);
            return null;
          }
          chunks.push(buf);
        }
        buffer = Buffer.concat(chunks);
      } catch {
        // Stream failed — fallback to writeFile + read
        const fs = await import('node:fs');
        const os = await import('node:os');
        const path = await import('node:path');
        const tmpPath = path.join(os.tmpdir(), `feishu-dl-${crypto.randomUUID()}`);
        try {
          await res.writeFile(tmpPath);
          buffer = fs.readFileSync(tmpPath);
          if (buffer.length > MAX_FILE_SIZE) return null;
        } finally {
          try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        }
      }

      if (!buffer || buffer.length === 0) return null;

      const base64 = buffer.toString('base64');
      const mimeType = MIME_BY_TYPE[resourceType] || 'application/octet-stream';
      const ext = resourceType === 'image' ? 'png'
        : resourceType === 'audio' ? 'ogg'
        : resourceType === 'video' ? 'mp4'
        : 'bin';

      return {
        id: crypto.randomUUID(),
        name: `${fileKey}.${ext}`,
        type: mimeType,
        size: buffer.length,
        data: base64,
      };
    } catch (err) {
      console.error(
        `[feishu] Resource download failed (type=${resourceType}, key=${fileKey}):`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  // ── Utilities ──────────────────────────────────────────────

  private addToDedup(messageId: string): void {
    this.seenMessageIds.set(messageId, true);
    if (this.seenMessageIds.size > DEDUP_MAX) {
      const excess = this.seenMessageIds.size - DEDUP_MAX;
      let removed = 0;
      for (const key of this.seenMessageIds.keys()) {
        if (removed >= excess) break;
        this.seenMessageIds.delete(key);
        removed++;
      }
    }
  }
}
