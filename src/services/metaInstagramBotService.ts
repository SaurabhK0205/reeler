import crypto from 'node:crypto';
import { generateUserVaultKey, getAdminVaultKey, createOtp, isOtpActive, OtpCapacityError } from './vaultAuthService.ts';
import { safeStringEqual } from '../middleware/security.ts';
import { loadConfig } from '../config.ts';
import { Repository, SenderReminderConflictError, SenderDeletionBarrierError } from '../db/repository.ts';
import { fetchReelMetadata } from './reelMetadataResolver.ts';
import { parseDuration, formatTargetTime } from '../utils/duration.ts';
import { getTimeZoneSummary } from '../utils/timezone.ts';
import { extractCreatorQueryWithFilter } from '../utils/creatorQuery.ts';
import {
  classifySavedMediaType,
  extractInstagramShortcodeAndPath,
  formatCanonicalInstagramUrl,
  resolveInboundMediaClassification,
} from '../utils/mediaType.ts';
import {
  parseWatchedStopCommand,
  extractPublicCreatorUsername,
  formatAddedToWatchLaterCreatorBlock,
  formatWatchedConfirmationMessage,
  formatReminderSetMessage,
  formatCreatorSearchMessages,
  formatSenderConflictRejectionMessage,
} from '../utils/reelMessages.ts';

/**
 * Options for sending messages via Meta Graph API.
 */
export interface SendDirectMessageOptions {
  /**
   * Optional message tag (e.g. 'HUMAN_AGENT' to message users up to 7 days after their last interaction).
   */
  tag?: 'HUMAN_AGENT';
  /**
   * If true (default), automatically attempts fallback with the HUMAN_AGENT tag
   * when standard delivery fails due to the 24-hour messaging window having elapsed.
   */
  allowHumanAgentFallback?: boolean;
}

/**
 * Determines whether a Meta Graph API response error indicates that the 24-hour
 * standard messaging window has closed for the given recipient.
 * @param {unknown} errorData - The parsed JSON error payload from Meta Graph API.
 * @returns {boolean} True if the error indicates an expired 24-hour messaging window.
 */
export function isMetaMessagingWindowError(errorData: unknown): boolean {
  if (!errorData || typeof errorData !== 'object') return false;
  const errorObj = (errorData as Record<string, unknown>).error;
  if (!errorObj || typeof errorObj !== 'object') return false;

  const code = (errorObj as Record<string, unknown>).code;
  const subcode = (errorObj as Record<string, unknown>).error_subcode;
  const message = (errorObj as Record<string, unknown>).message;

  if (code === 10 && subcode === 2018278) return true;
  if (typeof message === 'string' && /outside.*window|allowed window|24 hour/i.test(message)) {
    return true;
  }
  return false;
}

import type { SavedReel } from '../types.ts';

// Retain completed & committed-mutation mids for Meta's 24-hour webhook redelivery window.
const WEBHOOK_MID_DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
const WEBHOOK_MID_MAX_ENTRIES = 5000;
const WEBHOOK_PENDING_REPLY_TTL_MS = 15 * 60 * 1000;
const WEBHOOK_PENDING_REPLY_MAX_ENTRIES = 500;
const WEBHOOK_MAX_SCHEDULED_RETRIES = 200;
const DEFAULT_WEBHOOK_RETRY_DELAYS_MS = [2000, 8000];

interface WebhookRetryState {
  /** Preserves the exact Reel snapshot resolved on the initial duration command across internal retries. */
  pinnedDurationTargetReel?: SavedReel | null;
  /** Preserves the initially parsed target timestamp & duration across internal retries. */
  pinnedDuration?: ReturnType<typeof parseDuration>;
  /** Preserves the exact Watch Later Reel IDs resolved on the initial watched/stop command across retries. */
  pinnedWatchedTargetIds?: string[];
  /** Monotonic sequence assigned on initial reception of a timezone-set command to block stale retries. */
  timezoneCommandSeq?: number;
}

interface WebhookDeliveryContext {
  stateMutated: boolean;
  anyDeliveryFailed: boolean;
  unsentMessages: string[];
  retryState: WebhookRetryState;
  /** Tracks a newly issued OTP code so superseded OTP replies are discarded instead of replayed later. */
  issuedOtpCode?: string;
}

interface PendingWebhookReply {
  recipientId: string;
  messages: string[];
  expiresAt: number;
  otpCode?: string;
}

export class MetaInstagramBotService {
  private accessToken: string;
  private verifyToken: string;
  private appSecret: string;
  private retryDelaysMs: number[];
  private inFlightMessageIds = new Set<string>();
  private completedMessageIds = new Map<string, number>();
  private committedMutationMids = new Map<string, number>();
  private pendingRepliesByMid = new Map<string, PendingWebhookReply>();
  private scheduledRetries = new Map<string, ReturnType<typeof setTimeout>>();
  private timezoneCommandSeq = 0;
  private lastCommittedTimezoneSeqBySender = new Map<string, number>();
  public adminUserId: string | null = null;

  constructor(options?: { adminUserId?: string | null; retryDelaysMs?: number[] }) {
    this.accessToken = process.env.META_PAGE_ACCESS_TOKEN || '';
    this.verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN || 'rea_instagram_saved_token';
    this.appSecret = process.env.META_APP_SECRET || '';
    this.retryDelaysMs = options?.retryDelaysMs ?? DEFAULT_WEBHOOK_RETRY_DELAYS_MS;
    this.adminUserId =
      options?.adminUserId ||
      process.env.ADMIN_SENDER_ID ||
      process.env.INSTAGRAM_ADMIN_SENDER_ID ||
      null;
  }

  setAdminUserId(adminUserId: string | null): void {
    this.adminUserId = adminUserId;
  }

  get isConfigured(): boolean {
    return Boolean(this.accessToken);
  }

  /**
   * Validates Meta X-Hub-Signature-256 header using SHA-256 HMAC
   */
  verifySignature(rawBody: Buffer | string | undefined, signatureHeader?: string): boolean {
    if (!this.appSecret) {
      // Insecure bypass is strictly opt-in and forbidden in production
      const allowInsecure = process.env.ALLOW_INSECURE_WEBHOOK === 'true' && process.env.NODE_ENV !== 'production';
      if (allowInsecure) {
        console.warn('[MetaBot] WARNING: Webhook signature verification bypassed via ALLOW_INSECURE_WEBHOOK=true in non-production.');
        return true;
      }
      console.error('[MetaBot] Webhook rejected: META_APP_SECRET is not configured. Set META_APP_SECRET or explicit ALLOW_INSECURE_WEBHOOK=true for local dev.');
      return false;
    }

    if (!signatureHeader || !rawBody) {
      return false;
    }

    const parts = signatureHeader.split('=');
    if (parts.length !== 2 || parts[0] !== 'sha256') {
      return false;
    }

    const providedSignature = parts[1];
    const hmac = crypto.createHmac('sha256', this.appSecret);
    hmac.update(rawBody);
    const expectedSignature = hmac.digest('hex');

    if (providedSignature.length !== expectedSignature.length) {
      return false;
    }

    try {
      return crypto.timingSafeEqual(
        Buffer.from(providedSignature, 'hex'),
        Buffer.from(expectedSignature, 'hex')
      );
    } catch {
      return false;
    }
  }

  /**
   * Normalizes a Meta webhook message ID (`mid`) when present.
   */
  private normalizeWebhookMid(mid: unknown): string | null {
    if (typeof mid !== 'string') return null;
    const trimmed = mid.trim();
    return trimmed || null;
  }

  /**
   * Attempts to claim a webhook message ID for processing.
   * Separates in-flight claims from completed markers so failed deliveries remain retryable.
   */
  private claimWebhookMid(mid: string | null): boolean {
    if (!mid) return true;
    if (this.inFlightMessageIds.has(mid)) {
      return false;
    }
    const now = Date.now();
    const completedExpiry = this.completedMessageIds.get(mid);
    if (completedExpiry !== undefined) {
      if (completedExpiry > now) {
        return false;
      }
      this.completedMessageIds.delete(mid);
    }
    this.inFlightMessageIds.add(mid);
    return true;
  }

  /**
   * Marks a webhook message ID as successfully completed with bounded TTL/LRU eviction.
   */
  private markWebhookMidCompleted(mid: string | null): void {
    if (!mid) return;
    const now = Date.now();
    if (this.completedMessageIds.size >= WEBHOOK_MID_MAX_ENTRIES) {
      for (const [key, exp] of this.completedMessageIds.entries()) {
        if (exp <= now) {
          this.completedMessageIds.delete(key);
        }
      }
      while (this.completedMessageIds.size >= WEBHOOK_MID_MAX_ENTRIES) {
        const oldest = this.completedMessageIds.keys().next().value;
        if (oldest === undefined) break;
        this.completedMessageIds.delete(oldest);
      }
    }
    this.completedMessageIds.set(mid, now + WEBHOOK_MID_DEDUP_TTL_MS);
    this.pendingRepliesByMid.delete(mid);
  }

  /**
   * Records that a webhook mid has committed a state mutation so it cannot be re-executed during
   * Meta's 24-hour redelivery window even if pending reply text expires earlier.
   */
  private markWebhookMutationCommitted(mid: string | null): void {
    if (!mid) return;
    const now = Date.now();
    if (this.committedMutationMids.size >= WEBHOOK_MID_MAX_ENTRIES) {
      for (const [key, exp] of this.committedMutationMids.entries()) {
        if (exp <= now) {
          this.committedMutationMids.delete(key);
        }
      }
      while (this.committedMutationMids.size >= WEBHOOK_MID_MAX_ENTRIES) {
        const oldest = this.committedMutationMids.keys().next().value;
        if (oldest === undefined) break;
        this.committedMutationMids.delete(oldest);
      }
    }
    this.committedMutationMids.set(mid, now + WEBHOOK_MID_DEDUP_TTL_MS);
  }

  private hasCommittedWebhookMutation(mid: string | null): boolean {
    if (!mid) return false;
    const exp = this.committedMutationMids.get(mid);
    if (exp === undefined) return false;
    if (exp <= Date.now()) {
      this.committedMutationMids.delete(mid);
      return false;
    }
    return true;
  }

  private recordCommittedTimezoneSeq(senderId: string, seq: number): void {
    const existing = this.lastCommittedTimezoneSeqBySender.get(senderId) ?? 0;
    if (seq < existing) return;
    if (
      !this.lastCommittedTimezoneSeqBySender.has(senderId) &&
      this.lastCommittedTimezoneSeqBySender.size >= WEBHOOK_MID_MAX_ENTRIES
    ) {
      const oldest = this.lastCommittedTimezoneSeqBySender.keys().next().value;
      if (oldest !== undefined) {
        this.lastCommittedTimezoneSeqBySender.delete(oldest);
      }
    }
    this.lastCommittedTimezoneSeqBySender.set(senderId, seq);
  }

  /**
   * Stores unsent reply messages for a webhook mid whose side effects already committed,
   * so retries only redeliver the missing DM(s) without repeating mutations.
   */
  private recordPendingWebhookReplies(
    mid: string,
    recipientId: string,
    messages: string[],
    otpCode?: string
  ): void {
    const now = Date.now();
    if (this.pendingRepliesByMid.size >= WEBHOOK_PENDING_REPLY_MAX_ENTRIES) {
      for (const [key, entry] of this.pendingRepliesByMid.entries()) {
        if (entry.expiresAt <= now) {
          this.pendingRepliesByMid.delete(key);
        }
      }
      while (this.pendingRepliesByMid.size >= WEBHOOK_PENDING_REPLY_MAX_ENTRIES) {
        const oldest = this.pendingRepliesByMid.keys().next().value;
        if (oldest === undefined) break;
        this.pendingRepliesByMid.delete(oldest);
      }
    }
    this.pendingRepliesByMid.set(mid, {
      recipientId,
      messages,
      expiresAt: now + WEBHOOK_PENDING_REPLY_TTL_MS,
      ...(otpCode ? { otpCode } : {}),
    });
  }

  /**
   * Schedules a bounded internal retry for transient post-200 webhook processing or DM failures.
   * Uses unref'd timers so pending retries never block graceful shutdown.
   */
  private scheduleWebhookRetry(
    retryKey: string,
    attempt: number,
    task: () => Promise<void>
  ): void {
    if (attempt >= this.retryDelaysMs.length) return;
    if (this.scheduledRetries.has(retryKey)) return;
    if (this.scheduledRetries.size >= WEBHOOK_MAX_SCHEDULED_RETRIES) return;

    const delayMs = Math.max(0, this.retryDelaysMs[attempt]);
    const timer = setTimeout(() => {
      this.scheduledRetries.delete(retryKey);
      task().catch((err) => {
        console.error(`[MetaIG] Scheduled webhook retry failed for ${retryKey}:`, err);
      });
    }, delayMs);
    timer.unref();
    this.scheduledRetries.set(retryKey, timer);
  }

  /**
   * Cancels any pending internal webhook retry timers (useful for graceful shutdown or tests).
   */
  public clearPendingRetriesForTesting(): void {
    for (const timer of this.scheduledRetries.values()) {
      clearTimeout(timer);
    }
    this.scheduledRetries.clear();
  }

  /**
   * Sends a reply DM while tracking delivery failures in the active webhook delivery context.
   */
  private async deliverReply(
    recipientId: string,
    text: string,
    delivery?: WebhookDeliveryContext
  ): Promise<boolean> {
    const ok = await this.sendDirectMessage(recipientId, text);
    if (!ok && delivery) {
      delivery.anyDeliveryFailed = true;
      delivery.unsentMessages.push(text);
    }
    return ok;
  }

  /**
   * Validates Meta Webhook Verification Challenge (GET /webhook) using constant-time comparison.
   */
  verifyWebhook(mode: string, token: string, challenge: string): string | null {
    if (mode !== 'subscribe' || typeof token !== 'string' || !token) {
      return null;
    }
    const validTokens = process.env.META_WEBHOOK_VERIFY_TOKEN?.trim()
      ? [this.verifyToken]
      : [this.verifyToken, 'rea_instagram_saved_token', 'ig_reels_tracker_webhook_secret_2026'];
    if (validTokens.some((candidate) => candidate && safeStringEqual(token, candidate))) {
      return challenge;
    }
    return null;
  }

  /**
   * Sends a message to a user via Meta Graph API (automatically splits into safe chunks <= 950 chars).
   * Supports HUMAN_AGENT tag and automatic fallback when the standard 24-hour messaging window has elapsed.
   * @param {string} recipientId - The Instagram-scoped ID of the message recipient.
   * @param {string} text - Message text to send.
   * @param {SendDirectMessageOptions} [options] - Optional messaging configuration including tags and fallback behavior.
   * @returns {Promise<boolean>} Resolves to true if all message chunks were delivered successfully.
   */
  async sendDirectMessage(recipientId: string, text: string, options?: SendDirectMessageOptions): Promise<boolean> {
    if (!this.accessToken) {
      console.warn('[MetaIG] No META_PAGE_ACCESS_TOKEN configured. Cannot send DM reply.');
      return false;
    }

    const chunks = this.splitMessageIntoChunks(text, 950);
    let allSuccess = true;
    const initialTag = options?.tag;
    const allowFallback = options?.allowHumanAgentFallback !== false;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      try {
        const url = 'https://graph.facebook.com/v21.0/me/messages';
        const authHeaders = {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.accessToken}`,
        };
        const basePayload: Record<string, unknown> = {
          recipient: { id: recipientId },
          message: { text: chunk },
        };
        if (initialTag) {
          basePayload.tag = initialTag;
        }

        let res = await fetch(url, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify(basePayload),
          signal: AbortSignal.timeout(10000),
        });

        let data = (await res.json()) as any;

        // If standard delivery failed because the 24h window closed, attempt fallback with HUMAN_AGENT tag
        if (!res.ok && !initialTag && allowFallback && isMetaMessagingWindowError(data)) {
          console.warn(
            `[MetaIG] 24-hour messaging window closed for ${recipientId}. Attempting fallback with HUMAN_AGENT tag...`
          );
          const fallbackPayload = {
            recipient: { id: recipientId },
            message: { text: chunk },
            tag: 'HUMAN_AGENT',
          };
          res = await fetch(url, {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify(fallbackPayload),
            signal: AbortSignal.timeout(10000),
          });
          data = (await res.json()) as any;
          if (res.ok) {
            console.log(
              `[MetaIG] DM delivered to ${recipientId} via HUMAN_AGENT tag: "${chunk.slice(0, 40)}..."`
            );
          } else {
            console.error(
              `[MetaIG] HUMAN_AGENT tag fallback failed (requires Meta App Review approval for the Human Agent feature):`,
              data
            );
          }
        }

        if (!res.ok) {
          console.error('[MetaIG] Failed to send DM:', data);
          allSuccess = false;
          // Stop sending subsequent chunks on failure to avoid out-of-order partial messages
          break;
        } else {
          console.log(`[MetaIG] DM sent to ${recipientId}: "${chunk.slice(0, 40)}..."`);
        }
      } catch (e: any) {
        console.error('[MetaIG] Error calling Meta messages API:', e.message);
        allSuccess = false;
        // Stop sending on network or timeout exceptions
        break;
      }

      // Apply inter-chunk delay only between consecutive chunks, never after the final chunk
      if (i < chunks.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }

    return allSuccess;
  }

  /**
   * Splits a single continuous block of text into chunks of <= maxLen,
   * breaking on newline or space where possible, without emitting empty chunks
   * and handling leading whitespace safely.
   */
  private splitSingleBlock(text: string, maxLen: number): string[] {
    const result: string[] = [];
    let remaining = text.trim();

    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        if (remaining.trim()) {
          result.push(remaining);
        }
        break;
      }

      let splitIdx = remaining.lastIndexOf('\n', maxLen);
      if (splitIdx === -1 || splitIdx < maxLen / 2) {
        splitIdx = remaining.lastIndexOf(' ', maxLen);
      }
      if (splitIdx <= 0) {
        splitIdx = maxLen;
      }

      const chunk = remaining.slice(0, splitIdx).trim();
      if (chunk) {
        result.push(chunk);
      }

      remaining = remaining.slice(splitIdx).replace(/^[\r\n\t ]+/, '');
    }

    return result;
  }

  /**
   * Splits message text into chunks of at most maxLen characters (default 950),
   * respecting paragraph boundaries where possible to fit Meta Graph API DM limits.
   */
  public splitMessageIntoChunks(text: string, maxLen = 950): string[] {
    if (!text) return [];
    if (text.length <= maxLen) return [text];

    const chunks: string[] = [];
    const paragraphs = text.split('\n\n');
    let current = '';

    const flushCurrent = () => {
      if (!current) return;
      if (current.length <= maxLen) {
        chunks.push(current);
      } else {
        chunks.push(...this.splitSingleBlock(current, maxLen));
      }
      current = '';
    };

    for (const rawPara of paragraphs) {
      const para = rawPara.trim();
      if (!para) continue;

      if (para.length > maxLen) {
        flushCurrent();
        chunks.push(...this.splitSingleBlock(para, maxLen));
        continue;
      }

      if (!current) {
        current = para;
      } else if (current.length + 2 + para.length <= maxLen) {
        current += '\n\n' + para;
      } else {
        flushCurrent();
        current = para;
      }
    }

    flushCurrent();
    return chunks.length > 0 ? chunks : [text.slice(0, maxLen)];
  }

  /**
   * Dispatches a single normalized webhook message with in-flight claim tracking, 24h committed-mutation
   * deduplication, per-event operation IDs for mid-less events, internal post-200 retry scheduling,
   * pinned target context, and partial-reply replay.
   */
  private async dispatchWebhookMessage(
    senderId: string,
    rawMid: unknown,
    text: string,
    attachments: any[] | undefined,
    sourceLabel: 'messaging' | 'change',
    attempt: number = 0,
    existingOpId?: string,
    retryState: WebhookRetryState = {}
  ): Promise<void> {
    let reelUrl: string | null = null;
    let attachmentType: string | null = null;
    let attachmentTitle: string | null = null;
    if (Array.isArray(attachments)) {
      for (const att of attachments) {
        const urlCandidate =
          (typeof att?.payload?.url === 'string' && att.payload.url.trim()) ||
          (typeof att?.payload?.target?.url === 'string' && att.payload.target.url.trim()) ||
          (typeof att?.payload?.reel_url === 'string' && att.payload.reel_url.trim()) ||
          null;
        if (urlCandidate) {
          reelUrl = urlCandidate;
          attachmentType = typeof att.type === 'string' ? att.type : null;
          attachmentTitle =
            typeof att.payload?.title === 'string' && att.payload.title.trim()
              ? att.payload.title.trim()
              : null;
          break;
        }
        if (typeof att?.payload?.title === 'string' && att.payload.title.trim()) {
          const titleMatch = extractInstagramShortcodeAndPath(att.payload.title);
          if (titleMatch) {
            reelUrl = titleMatch.matchedText;
            attachmentType = typeof att.type === 'string' ? att.type : null;
            attachmentTitle = att.payload.title.trim();
            break;
          }
        }
      }
    }

    const combinedText = reelUrl ? `${reelUrl} ${text}`.trim() : text;
    if (!combinedText) return;

    // Use Meta's mid when supplied; for mid-less events, assign a unique per-received-event opId
    // so internal retries still retain an isolated mutation and pending-reply checkpoint.
    const opId = existingOpId || this.normalizeWebhookMid(rawMid) || `event_${crypto.randomUUID()}`;
    if (!this.claimWebhookMid(opId)) {
      return;
    }

    let shouldScheduleRetry = false;

    try {
      // If a prior attempt already committed state and only failed sending reply DM(s),
      // retry only the remaining unsent DM(s) without repeating the mutation.
      const pending = this.pendingRepliesByMid.get(opId);
      if (pending && pending.expiresAt > Date.now()) {
        if (pending.otpCode && !isOtpActive(pending.otpCode)) {
          // A newer login code superseded (or already consumed/expired) this OTP; discard stale reply.
          this.markWebhookMidCompleted(opId);
          return;
        }
        const remaining: string[] = [];
        let failed = false;
        for (const msg of pending.messages) {
          if (failed) {
            remaining.push(msg);
            continue;
          }
          const ok = await this.sendDirectMessage(pending.recipientId, msg);
          if (!ok) {
            failed = true;
            remaining.push(msg);
          }
        }
        if (!failed) {
          this.markWebhookMidCompleted(opId);
        } else {
          this.recordPendingWebhookReplies(opId, pending.recipientId, remaining, pending.otpCode);
          shouldScheduleRetry = true;
        }
        return;
      }
      if (pending) {
        this.pendingRepliesByMid.delete(opId);
      }
      // If the mutation already committed within Meta's 24h redelivery window (even after pending
      // reply text expired), never re-execute the command and risk repeating a stateful mutation.
      if (this.hasCommittedWebhookMutation(opId)) {
        this.markWebhookMidCompleted(opId);
        return;
      }

      const delivery: WebhookDeliveryContext = {
        stateMutated: false,
        anyDeliveryFailed: false,
        unsentMessages: [],
        retryState,
      };

      await this.processIncomingText(senderId, combinedText, attachmentType, attachmentTitle, delivery);

      if (delivery.stateMutated) {
        this.markWebhookMutationCommitted(opId);
      }

      if (!delivery.anyDeliveryFailed) {
        this.markWebhookMidCompleted(opId);
      } else {
        if (delivery.stateMutated && delivery.unsentMessages.length > 0) {
          this.recordPendingWebhookReplies(opId, senderId, delivery.unsentMessages, delivery.issuedOtpCode);
        }
        // The route already returned 200 EVENT_RECEIVED before dispatch, so Meta will not redeliver
        // this event; schedule a bounded internal retry preserving the opId and mutation checkpoint.
        shouldScheduleRetry = true;
      }
    } catch (error) {
      console.error(`[MetaIG] Failed to process ${sourceLabel} event for sender ${senderId}:`, error);
      // The route already sent 200 before dispatch; schedule a bounded internal retry after releasing claim.
      shouldScheduleRetry = true;
    } finally {
      this.inFlightMessageIds.delete(opId);
      if (shouldScheduleRetry) {
        this.scheduleWebhookRetry(opId, attempt, () =>
          this.dispatchWebhookMessage(
            senderId,
            rawMid,
            text,
            attachments,
            sourceLabel,
            attempt + 1,
            opId,
            retryState
          )
        );
      }
    }
  }

  /**
   * Handles incoming webhook event payload from Meta Graph API
   */
  async handleWebhookPayload(body: any): Promise<void> {
    console.log('[MetaIG] Webhook received body:', JSON.stringify(body, null, 2));

    // Official Meta Graph API Webhook format (handles both 'instagram' and 'page' objects)
    if ((body.object === 'instagram' || body.object === 'page') && Array.isArray(body.entry)) {
      for (const entry of body.entry) {
        // A. Standard messaging events
        const messaging = entry.messaging || [];
        for (const event of messaging) {
          const senderId = event.sender?.id;
          if (!senderId || event.message?.is_echo) continue;
          // Silently ignore passive read/delivery receipts and emoji reactions without actionable messages or postbacks
          if (!event.message && !event.postback) continue;
          const text =
            event.message?.text ||
            event.message?.quick_reply?.payload ||
            event.postback?.payload ||
            event.postback?.title ||
            '';
          const mid = event.message?.mid ?? event.postback?.mid;
          await this.dispatchWebhookMessage(
            senderId,
            mid,
            text,
            event.message?.attachments,
            'messaging'
          );
        }

        // B. Changes events (some webhook subscriptions dispatch via changes)
        const changes = entry.changes || [];
        for (const change of changes) {
          if ((change.field === 'messages' || change.field === 'messaging_postbacks') && change.value) {
            const val = change.value;
            const senderId = val.sender?.id;
            if (!senderId || val.message?.is_echo) continue;
            if (!val.message && !val.postback) continue;
            const text =
              val.message?.text ||
              val.message?.quick_reply?.payload ||
              val.postback?.payload ||
              val.postback?.title ||
              '';
            const mid = val.message?.mid ?? val.postback?.mid;
            await this.dispatchWebhookMessage(
              senderId,
              mid,
              text,
              val.message?.attachments,
              'change'
            );
          }
        }
      }
    }
  }

  /**
   * Processes incoming text/link from an Instagram user
   */
  private async processIncomingText(
    senderId: string,
    text: string,
    attachmentType?: string | null,
    attachmentTitle?: string | null,
    delivery?: WebhookDeliveryContext
  ): Promise<void> {
    console.log(`[MetaIG] Incoming DM from Instagram user ${senderId}: "${text}"`);
    const senderTz = await Repository.getSenderTimezone(senderId);

    // Check for Reel or Post URL
    const mediaLink = extractInstagramShortcodeAndPath(text);
    if (mediaLink) {
      const { shortcode, pathType, matchedText } = mediaLink;
      const remaining = text.replace(matchedText, '').trim();
      const customDuration = parseDuration(remaining, new Date(), senderTz);

      // Fetch public metadata (probe /p/ first for post links, /reel/ first for reel/tv links)
      const preferredPath = pathType === 'p' ? 'p' : 'reel';
      const [meta, existingItem] = await Promise.all([
        fetchReelMetadata(shortcode, undefined, preferredPath),
        Repository.getSavedItemByShortcode(shortcode, senderId),
      ]);

      // Read-only metadata reuse from another row with the same shortcode if this sender has no row yet
      const metadataFallbackItem = existingItem
        ? null
        : await Repository.getSavedItemByShortcode(shortcode);
      const metadataSeed = existingItem || metadataFallbackItem;

      const { mediaType, canonicalUrl } = resolveInboundMediaClassification({
        shortcode,
        pathType,
        matchedText,
        isClips: meta.isClips,
        mediaKind: meta.mediaKind,
        attachmentType,
        existing: metadataSeed,
      });

      const activeOwner = String(existingItem?.instagram_sender_id || '').trim();
      if (
        existingItem &&
        existingItem.watch_status === 'watch_later' &&
        activeOwner !== senderId
      ) {
        console.warn(
          `[MetaIG] Rejected Watch Later update for ${shortcode} from sender ${senderId}: active reminder already exists (${activeOwner ? 'another sender' : 'unattributed admin/UI'}).`
        );
        await this.deliverReply(senderId, formatSenderConflictRejectionMessage(mediaType), delivery);
        return;
      }

      const validHandle = extractPublicCreatorUsername({ username: meta.username });
      const existingCreator = metadataSeed?.creator;
      const existingHandle = extractPublicCreatorUsername(existingCreator);

      let creator: NonNullable<typeof existingCreator>;
      if (!validHandle && !meta.displayName && existingCreator) {
        creator = existingCreator;
      } else {
        const resolvedHandle = validHandle || existingHandle;
        const matchesExistingHandle =
          Boolean(resolvedHandle && existingHandle && resolvedHandle.toLowerCase() === existingHandle.toLowerCase());
        const reuseExistingCreatorId = matchesExistingHandle || (!validHandle && Boolean(existingCreator));
        const creatorExternalId = reuseExistingCreatorId
          ? existingCreator!.instagram_user_id
          : resolvedHandle
            ? `creator_${resolvedHandle}`
            : `creator_unattributed_${shortcode}`;

        creator = await Repository.upsertCreator({
          instagram_user_id: creatorExternalId,
          username: resolvedHandle || existingCreator?.username || 'Instagram Creator',
          display_name: meta.displayName || existingCreator?.display_name || resolvedHandle || 'Instagram Creator',
          profile_picture_url: existingCreator?.profile_picture_url || meta.thumbnailUrl || null,
        });
      }

      const instagramMediaId = existingItem?.instagram_media_id || `dm_${senderId}_${shortcode}`;
      const cleanAttachmentTitle = attachmentTitle?.trim() || null;
      const caption =
        meta.caption ||
        cleanAttachmentTitle ||
        existingItem?.caption ||
        metadataFallbackItem?.caption ||
        null;
      const thumbnailUrl =
        meta.thumbnailUrl ||
        existingItem?.thumbnail_url ||
        metadataFallbackItem?.thumbnail_url ||
        null;
      const nowIso = new Date().toISOString();
      const takenAt = existingItem?.taken_at || nowIso;
      // Preserve native IG membership/save date for existing IG items; new DM shares live under "Sent to Bot" (false, saved_at=null)
      const isSavedOnInstagram = existingItem ? existingItem.is_saved_on_instagram !== false : false;
      const savedAt = existingItem ? (existingItem.saved_at ?? null) : null;
      const firstDetectedAt = existingItem?.first_detected_at || nowIso;
      const saveOrderRank = existingItem?.save_order_rank ?? 1;

      const creatorLine = formatAddedToWatchLaterCreatorBlock({
        username: creator.username,
        display_name: creator.display_name,
      });

      const addedHeading = mediaType === 'post' ? '🖼️ Added post to your Watch Later!' : '🎬 Added to your Watch Later!';

      const nextReminder = customDuration ? customDuration.targetDate.toISOString() : null;
      const awaitingUntil = customDuration ? null : new Date(Date.now() + 10 * 60 * 1000).toISOString();

      try {
        await Repository.upsertSavedReel({
          instagram_media_id: instagramMediaId,
          shortcode,
          reel_url: canonicalUrl,
          media_type: mediaType,
          creator_id: creator.id,
          caption,
          thumbnail_url: thumbnailUrl,
          taken_at: takenAt,
          saved_at: savedAt,
          first_detected_at: firstDetectedAt,
          save_order_rank: saveOrderRank,
          watch_status: 'watch_later',
          reminder_interval_seconds: customDuration ? customDuration.seconds : null,
          next_reminder_at: nextReminder,
          awaiting_reminder_choice_until: awaitingUntil,
          is_saved_on_instagram: isSavedOnInstagram,
          instagram_sender_id: senderId,
        });
        if (delivery) delivery.stateMutated = true;
      } catch (error) {
        if (error instanceof SenderReminderConflictError) {
          console.warn(
            `[MetaIG] Concurrent Watch Later conflict for ${shortcode} from sender ${senderId}; existing reminder preserved.`
          );
          await this.deliverReply(senderId, formatSenderConflictRejectionMessage(mediaType), delivery);
          return;
        }
        if (error instanceof SenderDeletionBarrierError) {
          console.warn(
            `[MetaIG] Reel save rejected for sender ${senderId}: deletion barrier active.`
          );
          await this.deliverReply(
            senderId,
            `⏳ Your account data was recently deleted. Please wait 60 seconds before sharing new reels.`,
            delivery
          );
          return;
        }
        throw error;
      }

      if (customDuration) {
        // User provided a specific time along with the item!
        let reply = `${addedHeading}${creatorLine}\n\n⏰ Reminder set for: ${customDuration.label} (${customDuration.formattedTarget})\n\nReply "watched" when done!`;
        if (senderTz === 'UTC') {
          reply += `\n\n💡 Tip: Times are in UTC. Reply "tz <city>" (e.g. "tz New York" or "tz IST") to set your local timezone.`;
        }
        await this.deliverReply(senderId, reply, delivery);
      } else {
        // No time provided — wait up to 10 minutes for user choice before defaulting to 10 hours
        const defaultTriggerDate = new Date(Date.now() + (10 * 60 + 10 * 3600) * 1000);
        const defaultTriggerStr = formatTargetTime(defaultTriggerDate, new Date(), senderTz);
        const promptQuestion = mediaType === 'post'
          ? '⏰ When should I remind you to view this?'
          : '⏰ When should I remind you to watch this?';

        let reply = `${addedHeading}${creatorLine}\n\n${promptQuestion}\nReply with a time (e.g. "30m", "2h", "tomorrow at 5pm", or "remind me in 5 days").\n\n⏳ If you don't reply within 10 mins, I'll automatically set a reminder for 10 hours from now (${defaultTriggerStr})!`;
        if (senderTz === 'UTC') {
          reply += `\n\n💡 Tip: Times are in UTC. Reply "tz <city>" (e.g. "tz London" or "tz IST") to set your local timezone.`;
        }
        await this.deliverReply(senderId, reply, delivery);
      }
      return;
    }

    // 1. Mark as watched / stop command
    // Handles single ("watched", "done", "stop") and bulk ("stop all", "watched all", "clear all", "unsub")
    const { isCommand, markAll } = parseWatchedStopCommand(text);
    if (isCommand) {
      let targetReelIds: string[] | undefined;
      if (delivery) {
        if (delivery.retryState.pinnedWatchedTargetIds === undefined) {
          delivery.retryState.pinnedWatchedTargetIds = await Repository.selectWatchLaterTargetIdsForSender(
            senderId,
            { markAll }
          );
        }
        targetReelIds = delivery.retryState.pinnedWatchedTargetIds;
      }
      const { updatedReels, remainingCount, remainingReels } = await Repository.markWatchedForInstagramSender(senderId, {
        markAll,
        ...(targetReelIds !== undefined ? { targetReelIds } : {}),
      });
      if (delivery) delivery.stateMutated = true;
      const reply = formatWatchedConfirmationMessage(updatedReels, remainingCount, markAll, remainingReels);
      await this.deliverReply(senderId, reply, delivery);
      return;
    }

    // 1b. User data deletion command (e.g. "delete my data", "delete account", "purge data", "erase my data")
    const normalizedText = text.trim().toLowerCase();
    if (['delete my data', 'delete account', 'purge data', 'purge my data', 'erase my data', 'delete all my data'].includes(normalizedText)) {
      try {
        const deletedCount = await Repository.deleteUserDataForSender(senderId);
        if (delivery) delivery.stateMutated = true;
        const reply =
          `🗑️ Your data deletion request has been processed.\n\n` +
          `Permanently removed ${deletedCount} saved item(s) and cleared your user records from our systems.`;
        await this.deliverReply(senderId, reply, delivery);
      } catch (error) {
        console.error(`[MetaIG] Data deletion failed for sender ${senderId}:`, error);
        await this.deliverReply(
          senderId,
          `⚠️ We encountered an issue processing your data deletion request. Please try again or email saurabhk0205@gmail.com for manual assistance.`,
          delivery
        );
      }
      return;
    }

    // 2. Personal Vault / Web library link request (e.g. "vault", "library", "web", "dashboard", "link")
    if (['vault', 'library', 'web', 'dashboard', 'link', 'my vault'].includes(normalizedText)) {
      const isSenderAdmin = Boolean(this.adminUserId && senderId === this.adminUserId);
      const userKey = isSenderAdmin ? getAdminVaultKey() : generateUserVaultKey(senderId);
      const baseUrl = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || 'https://reeler-staging.onrender.com';
      const vaultUrl = `${baseUrl.replace(/\/+$/, '')}/?key=${userKey}`;

      const reply =
        `🎬 Your Personal Vault Link:\n${vaultUrl}\n\n` +
        `Tap to view your saved items in your browser. No login or password required!\n\n` +
        `Tip: If opening on a PC or laptop, you can also message "code" to get a 6-digit login code.\n\n` +
        `Note: The web library is an optional companion—you can manage reminders and searches entirely here in DMs.`;
      await this.deliverReply(senderId, reply, delivery);
      return;
    }

    // 2b. 6-Digit Login Code request for PC / Laptop browser vault access (e.g. "code", "otp", "login")
    if (['code', 'otp', 'login', 'login code', 'get code', 'passcode'].includes(normalizedText)) {
      const isSenderAdmin = Boolean(this.adminUserId && senderId === this.adminUserId);
      const session = isSenderAdmin ? { role: 'admin' as const } : { role: 'user' as const, senderId };
      let otpCode: string;
      try {
        otpCode = createOtp(session);
      } catch (error) {
        if (error instanceof OtpCapacityError) {
          await this.deliverReply(
            senderId,
            `⏳ Too many login codes are active right now. Please try again in a minute.`,
            delivery
          );
          return;
        }
        throw error;
      }
      if (delivery) {
        delivery.stateMutated = true;
        delivery.issuedOtpCode = otpCode;
      }

      const reply =
        `🔐 Your Reeler Login Code:\n${otpCode}\n\n` +
        `Enter this 6-digit code on your PC or laptop browser to unlock your private vault (valid for 10 minutes).`;
      await this.deliverReply(senderId, reply, delivery);
      return;
    }

    // 2c. Timezone check command (e.g. "tz", "timezone", "my timezone", "what is my timezone")
    if (['tz', 'timezone', 'my timezone', 'what is my timezone', 'time zone', 'my time'].includes(normalizedText)) {
      const tzSummary = getTimeZoneSummary(senderTz);
      const isDefault = senderTz === 'UTC';
      const reply =
        `🕒 Your timezone is currently set to: ${tzSummary}\n\n` +
        (isDefault
          ? `You are currently using default UTC.\nTo set your local timezone, reply with your city or timezone code:\n• "tz New York" or "tz EST"\n• "tz London" or "tz GMT"\n• "tz IST" or "tz Mumbai"\n• "tz Tokyo" or "tz Sydney"\n• "tz +5:30" or "tz -5"`
          : `To update your timezone anytime, reply e.g.:\n• "tz New York"\n• "tz London"\n• "tz IST"\n• "tz +5:30"`);
      await this.deliverReply(senderId, reply, delivery);
      return;
    }

    // 2d. Timezone set command (e.g. "tz IST", "tz America/New_York", "tz London", "timezone +5:30")
    const tzSetMatch = text.match(/^(?:tz|timezone|set\s+tz|set\s+timezone)\s+(.+)$/i);
    if (tzSetMatch) {
      const rawInput = tzSetMatch[1].trim();
      const cmdSeq =
        delivery?.retryState.timezoneCommandSeq ?? ++this.timezoneCommandSeq;
      if (delivery && delivery.retryState.timezoneCommandSeq === undefined) {
        delivery.retryState.timezoneCommandSeq = cmdSeq;
      }
      const lastCommittedSeq = this.lastCommittedTimezoneSeqBySender.get(senderId) ?? 0;
      if (cmdSeq < lastCommittedSeq) {
        // A newer timezone command already committed for this sender; discard stale retry.
        return;
      }

      const updatedTz = await Repository.setSenderTimezone(senderId, rawInput);
      if (updatedTz) {
        this.recordCommittedTimezoneSeq(senderId, cmdSeq);
        if (delivery) delivery.stateMutated = true;
        const tzSummary = getTimeZoneSummary(updatedTz);
        const reply =
          `✅ Timezone updated to ${tzSummary}!\n\n` +
          `All your reminders and scheduling choices will now be formatted and calculated in your local time.`;
        await this.deliverReply(senderId, reply, delivery);
      } else {
        const reply =
          `❌ Could not recognize timezone "${rawInput}".\n\n` +
          `Try replying with a major city or standard abbreviation, e.g.:\n• "tz New York"\n• "tz London"\n• "tz IST"\n• "tz Tokyo"\n• "tz +5:30"`;
        await this.deliverReply(senderId, reply, delivery);
      }
      return;
    }

    // 3. Custom duration command (e.g. "5s", "remind me in 5 days", "tomorrow at 5pm", "12 nov", etc.)
    const customDuration =
      delivery && delivery.retryState.pinnedDuration !== undefined
        ? delivery.retryState.pinnedDuration
        : parseDuration(text, new Date(), senderTz);
    if (delivery && delivery.retryState.pinnedDuration === undefined) {
      delivery.retryState.pinnedDuration = customDuration;
    }
    if (customDuration) {
      let targetReel: SavedReel | null;
      if (delivery && delivery.retryState.pinnedDurationTargetReel !== undefined) {
        // Reuse the exact Reel snapshot resolved on the initial attempt so an internal retry never
        // retargets a newer Reel saved after the first attempt failed.
        targetReel = delivery.retryState.pinnedDurationTargetReel;
      } else {
        const resolved =
          (await Repository.getActiveAwaitingReelForSender(senderId)) ||
          (await Repository.getLastReelForInstagramSender(senderId));
        targetReel = resolved ? { ...resolved } : null;
        if (delivery) {
          delivery.retryState.pinnedDurationTargetReel = targetReel;
        }
      }

      if (targetReel) {
        const nextDate = customDuration.targetDate.toISOString();
        const applied = await Repository.updateReminderSchedule(
          targetReel.id,
          nextDate,
          customDuration.seconds,
          {
            // Compare schedule & watch-status fields only so metadata-only updates (e.g. archive
            // promotion updating is_saved_on_instagram/updated_at) do not falsely discard durations.
            expectedNextReminderAt: targetReel.next_reminder_at ?? null,
            expectedIntervalSeconds: targetReel.reminder_interval_seconds ?? null,
            ...(targetReel.watch_status ? { expectedWatchStatus: targetReel.watch_status } : {}),
          }
        );
        if (!applied) {
          // A newer reminder schedule or watch-status change already updated this Reel before this retry ran.
          return;
        }
        if (delivery) delivery.stateMutated = true;
        let reply = formatReminderSetMessage(targetReel, customDuration.label, customDuration.formattedTarget);
        if (senderTz === 'UTC') {
          reply += `\n\n💡 Tip: Times are currently shown in UTC. Reply e.g. "tz New York" or "tz IST" to set your local time!`;
        }
        await this.deliverReply(senderId, reply, delivery);
      } else {
        let reply = `⏰ Got it! Duration set to ${customDuration.label} (${customDuration.formattedTarget}). Share any Reel or Post to track it!`;
        if (senderTz === 'UTC') {
          reply += `\n\n💡 Tip: Times are in UTC. Reply "tz <your city>" to use your local time.`;
        }
        await this.deliverReply(senderId, reply, delivery);
      }
      return;
    }

    // 3. Creator reels & posts search (e.g. "@_docthor_", "reels by @_docthor_", "posts by @the_political_compass")
    const creatorQuery = extractCreatorQueryWithFilter(text);
    if (creatorQuery) {
      const isSenderAdmin = Boolean(this.adminUserId && senderId === this.adminUserId);
      const { creator, reels, totalReelsCount, totalPostsCount } = await Repository.getReelsByCreatorUsername(
        creatorQuery.username,
        {
          mediaType: creatorQuery.mediaFilter,
          instagramSenderId: isSenderAdmin ? undefined : senderId,
        }
      );
      const cleanHandle = creatorQuery.username.replace(/^@/, '').trim();
      const resolvedUsername = creator?.username || cleanHandle;

      const reelItems = reels.filter(
        (r) => classifySavedMediaType({ mediaType: r.media_type, reelUrl: r.reel_url }) === 'reel'
      );
      const postItems = reels.filter(
        (r) => classifySavedMediaType({ mediaType: r.media_type, reelUrl: r.reel_url }) === 'post'
      );

      const isMixed = creatorQuery.mediaFilter === 'all' && totalReelsCount > 0 && totalPostsCount > 0;
      const reelsToSend = isMixed
        ? reelItems.slice(0, 3)
        : creatorQuery.mediaFilter === 'post'
          ? []
          : reelItems.slice(0, 5);
      const postsToSend = isMixed
        ? postItems.slice(0, 3)
        : creatorQuery.mediaFilter === 'reel'
          ? []
          : postItems.slice(0, 5);

      const searchCopy = formatCreatorSearchMessages({
        username: resolvedUsername,
        displayName: creator?.display_name,
        totalReelsCount,
        totalPostsCount,
        shownReelsCount: reelsToSend.length,
        shownPostsCount: postsToSend.length,
        mediaFilter: creatorQuery.mediaFilter,
      });

      if (!creator || (reelsToSend.length === 0 && postsToSend.length === 0)) {
        await this.deliverReply(senderId, searchCopy.notFound, delivery);
        return;
      }

      // Build ordered sequence so if a partial batch fails mid-way, only unsent trailing messages are queued
      const plannedMessages: string[] = [searchCopy.header];
      if (reelsToSend.length > 0) {
        if (searchCopy.reelsSectionHeader) plannedMessages.push(searchCopy.reelsSectionHeader);
        for (const r of reelsToSend) {
          plannedMessages.push(formatCanonicalInstagramUrl(r.shortcode, r.media_type, r.reel_url));
        }
      }
      if (postsToSend.length > 0) {
        if (searchCopy.postsSectionHeader) plannedMessages.push(searchCopy.postsSectionHeader);
        for (const r of postsToSend) {
          plannedMessages.push(formatCanonicalInstagramUrl(r.shortcode, r.media_type, r.reel_url));
        }
      }
      if (searchCopy.footer) {
        plannedMessages.push(searchCopy.footer);
      }

      for (let i = 0; i < plannedMessages.length; i++) {
        if (i > 0) {
          await new Promise((resolve) => setTimeout(resolve, 350));
        }
        const sent = await this.sendDirectMessage(senderId, plannedMessages[i]);
        if (!sent) {
          console.warn(`[MetaIG] Failed to send creator query message #${i + 1} to ${senderId}`);
          if (delivery) {
            delivery.anyDeliveryFailed = true;
            if (i > 0) {
              // Header/earlier items already reached the user; queue only unsent remainder on retry
              delivery.stateMutated = true;
              delivery.unsentMessages.push(...plannedMessages.slice(i));
            }
          }
          return;
        }
      }
      return;
    }

    // Default welcome / help reply
    const helpMsg = `👋 Hi! Whenever you see a Reel or Post you want to track or watch later:\n1. Tap Share (airplane icon)\n2. Send it here!\n\nAdd a time like "30m" or "2h" to set custom reminders.\nType any creator's username (or "reels by @name" / "posts by @name") to view your tracked items!\nType "tz" to check or set your local timezone!\nType "vault" to browse your saved items on the web, or "code" to get a 6-digit login code for your laptop.`;
    await this.deliverReply(senderId, helpMsg, delivery);
  }
}
