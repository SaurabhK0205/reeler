/**
 * Decodes common HTML entities found in Instagram meta attributes.
 */
function decodeHtml(html: string): string {
  return html
    .replace(/&#064;/g, '@')
    .replace(/&#x40;/g, '@')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

export type MediaKind = 'CLIPS' | 'FEED' | 'CAROUSEL_ITEM' | 'UNKNOWN';

export interface ExtractedReelMetadata {
  username?: string;
  displayName?: string;
  caption?: string;
  thumbnailUrl?: string;
  mediaKind?: MediaKind;
  isClips?: boolean | null;
}

export interface FeedMediaMetadata {
  shortcode: string;
  mediaKind: MediaKind;
  isClips: boolean | null;
  thumbAspectRatio: number | null;
  thumbnailUrl: string | null;
}

const SHORTCODE_PATTERN = /^[A-Za-z0-9_-]{5,32}$/;
const META_CACHE_TTL_MS = 30 * 60 * 1000;
const META_NEGATIVE_CACHE_TTL_MS = 60 * 1000;
const META_CACHE_MAX_ENTRIES = 500;
const MAX_IMAGE_PROBE_BYTES = 256 * 1024;
const MAX_CONCURRENT_UPSTREAM_RESOLVES = 6;
const MAX_QUEUED_RESOLVES = 18;
const UPSTREAM_BUDGET_WINDOW_MS = 60 * 1000;
const MAX_UPSTREAM_RESOLVES_PER_MINUTE = 120;

interface InFlightMetaEntry {
  promise: Promise<FeedMediaMetadata>;
  controller: AbortController;
  waiters: number;
}

interface ResolveQueueWaiter {
  resolve: () => void;
  reject: (err: Error) => void;
  cleanup: () => void;
}

const feedMetaCache = new Map<string, { value: FeedMediaMetadata; expiresAt: number }>();
const feedMetaInFlight = new Map<string, InFlightMetaEntry>();
let activeUpstreamResolves = 0;
const upstreamResolveQueue: ResolveQueueWaiter[] = [];
const upstreamResolveTimestamps: number[] = [];

/**
 * Clears cached feed metadata and upstream resolve budget state between isolated unit tests.
 */
export function resetFeedMetaResolverStateForTests(): void {
  feedMetaCache.clear();
  upstreamResolveTimestamps.length = 0;
}

/**
 * Enforces a sliding per-minute budget across uncached upstream Instagram lookups so cache misses
 * cannot trigger unbounded upstream requests.
 */
function consumeUpstreamResolveBudget(): void {
  const cutoff = Date.now() - UPSTREAM_BUDGET_WINDOW_MS;
  while (upstreamResolveTimestamps.length > 0 && upstreamResolveTimestamps[0] <= cutoff) {
    upstreamResolveTimestamps.shift();
  }
  if (upstreamResolveTimestamps.length >= MAX_UPSTREAM_RESOLVES_PER_MINUTE) {
    const budgetErr = new Error('Metadata resolver upstream rate budget reached') as Error & { code?: string };
    budgetErr.code = 'RATE_LIMITED';
    throw budgetErr;
  }
  upstreamResolveTimestamps.push(Date.now());
}

/**
 * Combines a timeout duration with an optional external AbortSignal cleanly.
 */
function createCombinedSignal(timeoutMs: number, externalSignal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return externalSignal ? AbortSignal.any([timeoutSignal, externalSignal]) : timeoutSignal;
}

/**
 * Throws a structured AbortError when an AbortSignal is already aborted.
 */
function createAbortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  const err = new Error('Metadata resolution aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * Acquires a bounded upstream resolve concurrency slot and per-minute upstream budget,
 * or throws a RATE_LIMITED error if overloaded.
 */
async function acquireResolveSlot(signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) {
    throw createAbortError(signal.reason);
  }

  consumeUpstreamResolveBudget();

  if (activeUpstreamResolves < MAX_CONCURRENT_UPSTREAM_RESOLVES) {
    activeUpstreamResolves++;
    return releaseResolveSlot;
  }

  if (upstreamResolveQueue.length >= MAX_QUEUED_RESOLVES) {
    const busyErr = new Error('Metadata resolver concurrency limit reached') as Error & { code?: string };
    busyErr.code = 'RATE_LIMITED';
    throw busyErr;
  }

  await new Promise<void>((resolve, reject) => {
    const entry: ResolveQueueWaiter = {
      resolve: () => {
        entry.cleanup();
        resolve();
      },
      reject: (err: Error) => {
        entry.cleanup();
        reject(err);
      },
      cleanup: () => {
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
      },
    };

    /**
     * Removes a queued waiter immediately if the upstream operation is aborted.
     */
    const onAbort = () => {
      const idx = upstreamResolveQueue.indexOf(entry);
      if (idx !== -1) {
        upstreamResolveQueue.splice(idx, 1);
      }
      entry.reject(createAbortError(signal?.reason));
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
    upstreamResolveQueue.push(entry);
  });

  activeUpstreamResolves++;
  return releaseResolveSlot;
}

/**
 * Releases one active upstream resolve slot and resumes the next queued waiter if present.
 */
function releaseResolveSlot(): void {
  if (activeUpstreamResolves > 0) {
    activeUpstreamResolves--;
  }
  const next = upstreamResolveQueue.shift();
  if (next) {
    next.resolve();
  }
}

/**
 * Validates that an Instagram shortcode matches allowed URL path characters and length bounds.
 */
export function isValidShortcode(shortcode: string): boolean {
  return SHORTCODE_PATTERN.test(shortcode);
}

/**
 * Ensures image probe URLs strictly target HTTPS Instagram or Meta CDN hosts to prevent SSRF.
 */
export function isAllowedInstagramMediaHost(urlString: string): boolean {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return (
      host === 'cdninstagram.com' ||
      host.endsWith('.cdninstagram.com') ||
      host === 'fbcdn.net' ||
      host.endsWith('.fbcdn.net')
    );
  } catch {
    return false;
  }
}

/**
 * Decodes Instagram's base64 `efg` query parameter to classify `CLIPS`, `FEED`, or `CAROUSEL_ITEM`.
 */
export function parseEfgMediaKind(urlString?: string | null): { mediaKind: MediaKind; isClips: boolean | null } {
  if (!urlString) return { mediaKind: 'UNKNOWN', isClips: null };
  try {
    const cleanUrl = decodeHtml(urlString);
    const parsed = new URL(cleanUrl);
    const rawEfg = parsed.searchParams.get('efg');
    if (!rawEfg) return { mediaKind: 'UNKNOWN', isClips: null };

    const normalizedB64 = rawEfg.replace(/-/g, '+').replace(/_/g, '/');
    const padLen = (4 - (normalizedB64.length % 4)) % 4;
    const paddedB64 = normalizedB64 + '='.repeat(padLen);
    const decodedJson = Buffer.from(paddedB64, 'base64').toString('utf8');
    const obj = JSON.parse(decodedJson);
    const tag = String(obj?.vencode_tag || obj?.efg_tag || '').toUpperCase();

    if (tag === 'CLIPS' || tag.startsWith('CLIPS.') || tag.startsWith('CLIPS_')) {
      return { mediaKind: 'CLIPS', isClips: true };
    }
    if (tag === 'CAROUSEL_ITEM' || tag.startsWith('CAROUSEL_ITEM.') || tag.startsWith('CAROUSEL_ITEM_')) {
      return { mediaKind: 'CAROUSEL_ITEM', isClips: false };
    }
    if (tag === 'FEED' || tag.startsWith('FEED.') || tag.startsWith('FEED_')) {
      return { mediaKind: 'FEED', isClips: false };
    }
    return { mediaKind: 'UNKNOWN', isClips: null };
  } catch {
    return { mediaKind: 'UNKNOWN', isClips: null };
  }
}

/**
 * Extracts width and height from PNG, GIF, WebP (VP8/VP8L/VP8X), or JPEG (SOF) binary headers.
 */
export function parseImageDimensionsFromBuffer(buf: Uint8Array): { width: number; height: number } | null {
  if (!buf || buf.length < 10) return null;

  // PNG: 89 50 4E 47 ... IHDR at bytes 16..23
  if (
    buf.length >= 24 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const width = view.getUint32(16, false);
    const height = view.getUint32(20, false);
    return width > 0 && height > 0 ? { width, height } : null;
  }

  // GIF87a / GIF89a
  if (
    buf.length >= 10 &&
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38
  ) {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const width = view.getUint16(6, true);
    const height = view.getUint16(8, true);
    return width > 0 && height > 0 ? { width, height } : null;
  }

  // WEBP (RIFF....WEBP)
  if (
    buf.length >= 25 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    const chunkTag = String.fromCharCode(buf[12], buf[13], buf[14], buf[15]);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (chunkTag === 'VP8 ' && buf.length >= 30 && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
      const width = view.getUint16(26, true) & 0x3fff;
      const height = view.getUint16(28, true) & 0x3fff;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (chunkTag === 'VP8L' && buf.length >= 25 && buf[20] === 0x2f) {
      const bits = view.getUint32(21, true);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >>> 14) & 0x3fff) + 1;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (chunkTag === 'VP8X' && buf.length >= 30) {
      const width = (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1;
      const height = (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1;
      return width > 0 && height > 0 ? { width, height } : null;
    }
  }

  // JPEG: FF D8
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 1 < buf.length) {
      while (i < buf.length && buf[i] !== 0xff) i++;
      while (i < buf.length && buf[i] === 0xff) i++;
      if (i >= buf.length) break;
      const marker = buf[i++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      if (i + 1 >= buf.length) break;
      const segmentLength = (buf[i] << 8) | buf[i + 1];
      if (segmentLength < 2) break;
      const isSof =
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc;
      if (isSof && i + 6 < buf.length) {
        const height = (buf[i + 3] << 8) | buf[i + 4];
        const width = (buf[i + 5] << 8) | buf[i + 6];
        return width > 0 && height > 0 ? { width, height } : null;
      }
      i += segmentLength;
    }
  }

  return null;
}

/**
 * Incrementally parses image dimensions from a readable byte stream into a single bounded buffer
 * and cancels the stream reader on every exit path.
 */
export async function readImageDimensionsFromStream(
  body: ReadableStream<Uint8Array>,
  maxBytes: number = MAX_IMAGE_PROBE_BYTES
): Promise<{ width: number; height: number } | null> {
  const reader = body.getReader();
  const limit = Math.max(24, maxBytes);
  const probeBuf = new Uint8Array(limit);
  let totalBytes = 0;

  try {
    while (totalBytes < limit) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const copyLen = Math.min(value.byteLength, limit - totalBytes);
      if (copyLen <= 0) break;
      probeBuf.set(value.subarray(0, copyLen), totalBytes);
      totalBytes += copyLen;

      const dims = parseImageDimensionsFromBuffer(probeBuf.subarray(0, totalBytes));
      if (dims) return dims;
    }
    return null;
  } finally {
    try {
      await reader.cancel().catch(() => {});
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Reader already released
      }
    }
  }
}

/**
 * Fetches only the leading image header bytes from an allowed Instagram CDN URL to extract
 * natural pixel dimensions without downloading full media payloads.
 */
async function fetchImageDimensions(
  urlString: string,
  signal?: AbortSignal
): Promise<{ width: number; height: number } | null> {
  if (!isAllowedInstagramMediaHost(urlString)) return null;
  if (signal?.aborted) return null;

  const combinedSignal = createCombinedSignal(4500, signal);
  try {
    let currentUrl = urlString;
    let res: Response | null = null;
    for (let redirects = 0; redirects < 3; redirects++) {
      if (!isAllowedInstagramMediaHost(currentUrl)) return null;
      const attempt = await fetch(currentUrl, { signal: combinedSignal, redirect: 'manual' });
      if (attempt.status >= 300 && attempt.status < 400) {
        const location = attempt.headers.get('location');
        await attempt.body?.cancel().catch(() => {});
        if (!location) return null;
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      res = attempt;
      break;
    }
    if (!res) return null;
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => {});
      return null;
    }

    return await readImageDimensionsFromStream(res.body, MAX_IMAGE_PROBE_BYTES);
  } catch {
    return null;
  }
}

/**
 * Fetches Instagram OpenGraph metadata for a saved reel or post shortcode,
 * probing the preferred URL path (`/reel/` or `/p/`) first and falling back to the alternate path on non-OK HTTP status.
 */
export async function fetchReelMetadata(
  shortcode: string,
  signal?: AbortSignal,
  preferredPath?: 'reel' | 'p'
): Promise<ExtractedReelMetadata> {
  if (!isValidShortcode(shortcode)) {
    return {};
  }
  if (signal?.aborted) {
    return {};
  }

  const pathsToTry: Array<'reel' | 'p'> = preferredPath === 'p' ? ['p', 'reel'] : ['reel', 'p'];

  try {
    let html: string | null = null;

    for (const pathSegment of pathsToTry) {
      if (signal?.aborted) {
        return {};
      }
      const url = `https://www.instagram.com/${pathSegment}/${encodeURIComponent(shortcode)}/`;
      const res = await fetch(url, {
        signal: createCombinedSignal(8000, signal),
        headers: {
          'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });

      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        continue;
      }

      const candidateHtml = await res.text();
      if (!/<meta\s+(?:property|name)="(?:og:url|og:image|twitter:title|og:title)"/i.test(candidateHtml)) {
        continue;
      }

      html = candidateHtml;
      break;
    }

    if (!html) {
      return {};
    }

    const ogUrl = decodeHtml(html.match(/<meta property="og:url" content="([^"]+)"/i)?.[1] || '');
    const rawTwitterTitle = html.match(/<meta name="twitter:title" content="([^"]+)"/i)?.[1] || '';
    const twitterTitle = decodeHtml(rawTwitterTitle);
    const rawTitle = html.match(/<meta property="og:title" content="([^"]+)"/i)?.[1] || '';
    const ogTitle = decodeHtml(rawTitle);
    const rawDesc = html.match(/<meta property="og:description" content="([^"]+)"/i)?.[1] || '';
    const ogDesc = decodeHtml(rawDesc);
    const rawOgImage = html.match(/<meta property="og:image" content="([^"]+)"/i)?.[1];
    const ogImage = rawOgImage ? decodeHtml(rawOgImage) : undefined;

    let username: string | undefined;

    // Strategy 1: og:url (e.g. "https://www.instagram.com/aapka_sanskari_pati_hu/reel/Db4eVUcsoTh/")
    const urlMatch = ogUrl.match(/instagram\.com\/([a-zA-Z0-9._]+)\/(?:reel|reels|p|tv)\//i);
    if (urlMatch && !['reel', 'reels', 'p', 'tv', 'stories'].includes(urlMatch[1].toLowerCase())) {
      username = urlMatch[1];
    }

    // Strategy 2: twitter:title (e.g. "ज़रणेश (@aapka_sanskari_pati_hu) • Instagram reel")
    if (!username) {
      const twMatch = twitterTitle.match(/\(@?([a-zA-Z0-9._]+)\)/);
      if (twMatch && twMatch[1] !== 'instagram') {
        username = twMatch[1];
      }
    }

    // Strategy 3: og:description tail (e.g. "... - aapka_sanskari_pati_hu" or "... - @username")
    if (!username) {
      const descTailMatch = ogDesc.match(/-\s*@?([a-zA-Z0-9._]+)\s*$/);
      if (descTailMatch) {
        username = descTailMatch[1];
      }
    }

    // Strategy 4: og:description comments (e.g. "comments - username on date:")
    if (!username) {
      username = ogDesc.match(/comments\s*-\s*@?([a-zA-Z0-9._]+)\s+on/i)?.[1];
    }

    // Strategy 5: og:title (e.g. "@username on Instagram")
    if (!username) {
      const titleAtMatch = ogTitle.match(/@([a-zA-Z0-9._]+)/);
      if (titleAtMatch && titleAtMatch[1] !== 'instagram') {
        username = titleAtMatch[1];
      }
    }

    // Strategy 6: Embedded JSON in HTML (e.g. "owner":{"username":"..."})
    if (!username) {
      const jsonOwnerMatch = html.match(/"owner":\s*\{[^}]*"username":\s*"([a-zA-Z0-9._]+)"/i);
      if (jsonOwnerMatch) {
        username = jsonOwnerMatch[1];
      }
    }

    // Extract display name
    let displayName: string | undefined;
    const twNameMatch = twitterTitle.match(/^(.+?)\s*\(@/);
    if (twNameMatch) {
      displayName = twNameMatch[1].trim();
    } else {
      const ogNameMatch = ogTitle.match(/^(.+?)\s+on Instagram/i);
      if (ogNameMatch) {
        displayName = ogNameMatch[1].trim();
      }
    }

    // Extract clean caption
    let caption = ogDesc;
    const captionQuoteMatch = ogDesc.match(/[:\u300c]\s*"?([\s\S]+?)"?[\u300d\.]?\s*-\s*\d+/);
    if (captionQuoteMatch) {
      caption = captionQuoteMatch[1].trim();
    } else {
      const simpleQuote = ogDesc.match(/: "([\s\S]+?)"\.?\s*$/);
      if (simpleQuote) {
        caption = simpleQuote[1].trim();
      }
    }

    const efgMeta = parseEfgMediaKind(ogImage);
    let mediaKind: MediaKind = efgMeta.mediaKind;
    let isClips: boolean | null = efgMeta.isClips;

    if (isClips === null && ogUrl) {
      if (/\/(?:reel|reels|tv)\//i.test(ogUrl)) {
        mediaKind = 'CLIPS';
        isClips = true;
      } else if (/\/p\//i.test(ogUrl)) {
        mediaKind = 'FEED';
        isClips = false;
      }
    }

    return {
      username: username?.toLowerCase(),
      displayName: displayName || username,
      caption,
      thumbnailUrl: ogImage,
      mediaKind,
      isClips,
    };
  } catch (e: any) {
    if (!signal?.aborted && e?.name !== 'AbortError') {
      console.error(`[MetadataResolver] Failed to resolve shortcode ${shortcode}:`, e.message);
    }
    return {};
  }
}

/**
 * Selects the HTTP `Cache-Control` header matching resolver cache semantics so empty/negative
 * transient failures never stick in browser caches for 30 minutes.
 */
export function feedMetaCacheControl(meta: FeedMediaMetadata): string {
  return meta.thumbnailUrl || meta.isClips !== null ? 'private, max-age=1800' : 'no-store';
}

/**
 * Resolves cached or live media classification and aspect metadata for the adaptive feed player,
 * coalescing concurrent lookups, bounding upstream concurrency, propagating client cancellation,
 * and applying short negative caching for failed lookups.
 */
export async function resolveFeedMediaMetadata(
  shortcode: string,
  signal?: AbortSignal,
  preferredPath?: 'reel' | 'p'
): Promise<FeedMediaMetadata> {
  if (!isValidShortcode(shortcode)) {
    throw new Error('Invalid shortcode format');
  }
  if (signal?.aborted) {
    throw createAbortError(signal.reason);
  }

  const now = Date.now();
  const cached = feedMetaCache.get(shortcode);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }
  if (cached) {
    feedMetaCache.delete(shortcode);
  }

  let entry = feedMetaInFlight.get(shortcode);
  if (entry?.controller.signal.aborted) {
    feedMetaInFlight.delete(shortcode);
    entry = undefined;
  }
  if (!entry) {
    const controller = new AbortController();
    const promise = (async (): Promise<FeedMediaMetadata> => {
      const releaseSlot = await acquireResolveSlot(controller.signal);
      try {
        const meta = await fetchReelMetadata(shortcode, controller.signal, preferredPath);
        const thumbnailUrl = meta.thumbnailUrl || null;
        const mediaKind: MediaKind = meta.mediaKind ?? 'UNKNOWN';
        const isClips: boolean | null = meta.isClips ?? null;

        let thumbAspectRatio: number | null = null;
        if (thumbnailUrl && isClips === true && !controller.signal.aborted) {
          const dims = await fetchImageDimensions(thumbnailUrl, controller.signal);
          if (dims && dims.height > 0) {
            thumbAspectRatio = Math.round((dims.width / dims.height) * 1000) / 1000;
          }
        }

        const result: FeedMediaMetadata = {
          shortcode,
          mediaKind,
          isClips,
          thumbAspectRatio,
          thumbnailUrl,
        };

        if (!controller.signal.aborted) {
          if (feedMetaCache.size >= META_CACHE_MAX_ENTRIES) {
            const oldestKey = feedMetaCache.keys().next().value;
            if (oldestKey) feedMetaCache.delete(oldestKey);
          }
          const hasUsefulMeta = Boolean(thumbnailUrl || isClips !== null);
          feedMetaCache.set(shortcode, {
            value: result,
            expiresAt: Date.now() + (hasUsefulMeta ? META_CACHE_TTL_MS : META_NEGATIVE_CACHE_TTL_MS),
          });
        }

        return result;
      } finally {
        releaseSlot();
      }
    })();

    entry = { promise, controller, waiters: 0 };
    feedMetaInFlight.set(shortcode, entry);
    promise.finally(() => {
      if (feedMetaInFlight.get(shortcode) === entry) {
        feedMetaInFlight.delete(shortcode);
      }
    }).catch(() => {});
  }

  entry.waiters++;
  let waiterSettled = false;

  /**
   * Aborts the shared upstream lookup only when the last active caller disconnects.
   */
  const onCallerAbort = () => {
    if (waiterSettled) return;
    waiterSettled = true;
    entry!.waiters = Math.max(0, entry!.waiters - 1);
    if (entry!.waiters === 0) {
      entry!.controller.abort();
    }
  };

  if (signal) {
    signal.addEventListener('abort', onCallerAbort, { once: true });
  }

  try {
    if (!signal) {
      return await entry.promise;
    }
    return await new Promise<FeedMediaMetadata>((resolve, reject) => {
      /**
       * Rejects this caller's promise immediately upon request cancellation.
       */
      const abortReject = () => reject(createAbortError(signal.reason));
      signal.addEventListener('abort', abortReject, { once: true });
      entry!.promise.then(
        (res) => {
          signal.removeEventListener('abort', abortReject);
          resolve(res);
        },
        (err) => {
          signal.removeEventListener('abort', abortReject);
          reject(err);
        }
      );
    });
  } finally {
    if (signal) {
      signal.removeEventListener('abort', onCallerAbort);
    }
    if (!waiterSettled) {
      waiterSettled = true;
      entry.waiters = Math.max(0, entry.waiters - 1);
    }
  }
}
