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
const META_CACHE_MAX_ENTRIES = 500;
const MAX_IMAGE_PROBE_BYTES = 256 * 1024;

const feedMetaCache = new Map<string, { value: FeedMediaMetadata; expiresAt: number }>();
const feedMetaInFlight = new Map<string, Promise<FeedMediaMetadata>>();

export function isValidShortcode(shortcode: string): boolean {
  return SHORTCODE_PATTERN.test(shortcode);
}

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

async function fetchImageDimensions(urlString: string): Promise<{ width: number; height: number } | null> {
  if (!isAllowedInstagramMediaHost(urlString)) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4500);
  try {
    let currentUrl = urlString;
    let res: Response | null = null;
    for (let redirects = 0; redirects < 3; redirects++) {
      if (!isAllowedInstagramMediaHost(currentUrl)) return null;
      const attempt = await fetch(currentUrl, { signal: controller.signal, redirect: 'manual' });
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
    if (!res || !res.ok || !res.body) return null;

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    while (totalBytes < MAX_IMAGE_PROBE_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      totalBytes += value.byteLength;

      const combined = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const dims = parseImageDimensionsFromBuffer(combined);
      if (dims) {
        await reader.cancel().catch(() => {});
        return dims;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchReelMetadata(shortcode: string): Promise<ExtractedReelMetadata> {
  if (!isValidShortcode(shortcode)) {
    return {};
  }

  try {
    const url = `https://www.instagram.com/reel/${encodeURIComponent(shortcode)}/`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: {
        'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (!res.ok) {
      return {};
    }

    const html = await res.text();
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
    const urlMatch = ogUrl.match(/instagram\.com\/([a-zA-Z0-9._]+)\/(?:reel|p)\//i);
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
      if (/\/reel\//i.test(ogUrl)) {
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
    console.error(`[MetadataResolver] Failed to resolve shortcode ${shortcode}:`, e.message);
    return {};
  }
}

export async function resolveFeedMediaMetadata(shortcode: string): Promise<FeedMediaMetadata> {
  if (!isValidShortcode(shortcode)) {
    throw new Error('Invalid shortcode format');
  }

  const now = Date.now();
  const cached = feedMetaCache.get(shortcode);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }
  if (cached) {
    feedMetaCache.delete(shortcode);
  }

  const existingPromise = feedMetaInFlight.get(shortcode);
  if (existingPromise) {
    return existingPromise;
  }

  const task = (async (): Promise<FeedMediaMetadata> => {
    const meta = await fetchReelMetadata(shortcode);
    const thumbnailUrl = meta.thumbnailUrl || null;
    const mediaKind: MediaKind = meta.mediaKind ?? 'UNKNOWN';
    const isClips: boolean | null = meta.isClips ?? null;

    let thumbAspectRatio: number | null = null;
    if (thumbnailUrl && isClips === true) {
      const dims = await fetchImageDimensions(thumbnailUrl);
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

    if (thumbnailUrl || isClips !== null) {
      if (feedMetaCache.size >= META_CACHE_MAX_ENTRIES) {
        const oldestKey = feedMetaCache.keys().next().value;
        if (oldestKey) feedMetaCache.delete(oldestKey);
      }
      feedMetaCache.set(shortcode, {
        value: result,
        expiresAt: Date.now() + META_CACHE_TTL_MS,
      });
    }

    return result;
  })();

  feedMetaInFlight.set(shortcode, task);
  try {
    return await task;
  } finally {
    feedMetaInFlight.delete(shortcode);
  }
}
