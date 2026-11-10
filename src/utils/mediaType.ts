import type { SavedMediaType, SavedReel } from '../types.ts';

export type InstagramPathType = 'reel' | 'p' | 'tv';

export interface ParsedInstagramMediaLink {
  shortcode: string;
  pathType: InstagramPathType;
  mediaType: SavedMediaType;
  matchedText: string;
}

const INSTAGRAM_MEDIA_URL_REGEX =
  /https?:\/\/(?:www\.)?instagram\.com\/(?:(?!stories\/)[a-zA-Z0-9._]+\/)?(reel|reels|p|tv)\/([A-Za-z0-9_-]+)/i;

/**
 * Classifies a saved Instagram item as `'reel'` or `'post'` from explicit classification,
 * resolver `isClips`/`mediaKind` flags, attachment metadata, or canonical URL path.
 */
export function classifySavedMediaType(input?: {
  mediaType?: string | null;
  reelUrl?: string | null;
  isClips?: boolean | null;
  mediaKind?: string | null;
  attachmentType?: string | null;
}): SavedMediaType {
  const explicit = typeof input?.mediaType === 'string' ? input.mediaType.trim().toLowerCase() : '';
  if (explicit === 'post' || explicit === 'reel') {
    return explicit;
  }

  const kind = typeof input?.mediaKind === 'string' ? input.mediaKind.trim().toUpperCase() : '';
  if (input?.isClips === false || kind === 'FEED' || kind === 'CAROUSEL_ITEM') {
    return 'post';
  }
  if (input?.isClips === true || kind === 'CLIPS') {
    return 'reel';
  }

  const url = typeof input?.reelUrl === 'string' ? input.reelUrl : '';
  if (/instagram\.com\/(?:[a-zA-Z0-9._]+\/)?p\//i.test(url)) {
    return 'post';
  }
  if (/instagram\.com\/(?:[a-zA-Z0-9._]+\/)?(?:reel|reels|tv)\//i.test(url)) {
    return 'reel';
  }

  const attType = typeof input?.attachmentType === 'string' ? input.attachmentType.trim().toLowerCase() : '';
  if (attType === 'image' || attType === 'photo' || attType === 'carousel' || attType === 'ig_post') {
    return 'post';
  }

  return 'reel';
}

/**
 * Parses and strictly validates an Instagram media URL (with optional creator username prefix,
 * excluding `/stories/`, `/explore/`, `/accounts/`) into shortcode, path type, and `'reel' | 'post'` media type.
 */
export function parseCanonicalInstagramMediaUrl(
  href: string
): (ParsedInstagramMediaLink & { creatorHandleFromPath?: string }) | null {
  try {
    const parsedUrl = new URL(String(href || '').trim());
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return null;
    }
    const host = parsedUrl.hostname.toLowerCase();
    if (host !== 'instagram.com' && host !== 'www.instagram.com') {
      return null;
    }
    const pathMatch = parsedUrl.pathname.match(
      /^\/(?:(?!stories\/|explore\/|accounts\/)([a-zA-Z0-9._]{1,30})\/)?(reel|reels|p|tv)\/([A-Za-z0-9_-]+)\/?$/i
    );
    if (!pathMatch) {
      return null;
    }
    const rawSegment = pathMatch[2].toLowerCase();
    const pathType: InstagramPathType = rawSegment === 'p' ? 'p' : (rawSegment === 'tv' ? 'tv' : 'reel');
    const shortcode = pathMatch[3];
    const mediaType: SavedMediaType = pathType === 'p' ? 'post' : 'reel';

    return {
      shortcode,
      pathType,
      mediaType,
      matchedText: parsedUrl.href,
      ...(pathMatch[1] ? { creatorHandleFromPath: pathMatch[1].toLowerCase() } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Extracts shortcode, Instagram URL path segment (`reel`, `p`, `tv`), and inferred media type from inbound text.
 */
export function extractInstagramShortcodeAndPath(text: string): ParsedInstagramMediaLink | null {
  const match = String(text || '').match(INSTAGRAM_MEDIA_URL_REGEX);
  if (!match) {
    return null;
  }

  const rawSegment = match[1].toLowerCase();
  const pathType: InstagramPathType = rawSegment === 'p' ? 'p' : (rawSegment === 'tv' ? 'tv' : 'reel');
  const shortcode = match[2];
  const mediaType: SavedMediaType = pathType === 'p' ? 'post' : 'reel';

  return {
    shortcode,
    pathType,
    mediaType,
    matchedText: match[0],
  };
}

/**
 * Builds a canonical Instagram URL preserving `/p/` for Posts, `/tv/` for legacy IGTV links, and `/reel/` for Reels.
 */
export function formatCanonicalInstagramUrl(
  shortcode: string,
  mediaType?: SavedMediaType | null,
  existingUrl?: string | null
): string {
  const cleanCode = encodeURIComponent(String(shortcode || '').trim());
  const resolvedType = classifySavedMediaType({ mediaType, reelUrl: existingUrl });

  if (resolvedType === 'post') {
    return `https://www.instagram.com/p/${cleanCode}/`;
  }
  if (existingUrl && /instagram\.com\/(?:[a-zA-Z0-9._]+\/)?tv\//i.test(existingUrl)) {
    return `https://www.instagram.com/tv/${cleanCode}/`;
  }
  return `https://www.instagram.com/reel/${cleanCode}/`;
}

/**
 * Resolves `media_type` and canonical Instagram URL for an inbound DM link while preserving any
 * previously recovered `'post'` classification and `/p/` URL if live metadata lookup is inconclusive
 * on a legacy `/reel/` URL, while allowing conclusive metadata to update classification.
 */
export function resolveInboundMediaClassification(params: {
  shortcode: string;
  pathType: InstagramPathType;
  matchedText: string;
  isClips?: boolean | null;
  mediaKind?: string | null;
  attachmentType?: string | null;
  existing?: Pick<SavedReel, 'media_type' | 'reel_url'> | null;
}): { mediaType: SavedMediaType; canonicalUrl: string } {
  const attType = typeof params.attachmentType === 'string' ? params.attachmentType.trim().toLowerCase() : '';
  const hasPostAttachment = attType === 'image' || attType === 'photo' || attType === 'carousel' || attType === 'ig_post';
  const kind = typeof params.mediaKind === 'string' ? params.mediaKind.trim().toUpperCase() : '';
  const hasConclusiveMeta =
    typeof params.isClips === 'boolean' || kind === 'FEED' || kind === 'CAROUSEL_ITEM' || kind === 'CLIPS';
  const existingHint =
    params.pathType === 'tv' ? `https://www.instagram.com/tv/${encodeURIComponent(params.shortcode)}/` : params.matchedText;

  if (params.pathType === 'p') {
    const mediaType: SavedMediaType = params.isClips === true || kind === 'CLIPS' ? 'reel' : 'post';
    const canonicalUrl = formatCanonicalInstagramUrl(
      params.shortcode,
      mediaType,
      mediaType === 'post' ? 'https://www.instagram.com/p/' : existingHint
    );
    return { mediaType, canonicalUrl };
  }

  if (hasConclusiveMeta) {
    const mediaType = classifySavedMediaType({
      isClips: params.isClips,
      mediaKind: params.mediaKind,
    });
    const canonicalUrl = formatCanonicalInstagramUrl(
      params.shortcode,
      mediaType,
      mediaType === 'post' ? undefined : existingHint
    );
    return { mediaType, canonicalUrl };
  }

  if (hasPostAttachment) {
    return {
      mediaType: 'post',
      canonicalUrl: formatCanonicalInstagramUrl(params.shortcode, 'post'),
    };
  }

  if (params.existing) {
    const preservedType = classifySavedMediaType({
      mediaType: params.existing.media_type,
      reelUrl: params.existing.reel_url,
    });
    return {
      mediaType: preservedType,
      canonicalUrl: formatCanonicalInstagramUrl(params.shortcode, preservedType, params.existing.reel_url),
    };
  }

  const fallbackType = classifySavedMediaType({
    mediaType: params.pathType === 'p' ? 'post' : 'reel',
    isClips: params.isClips,
    mediaKind: params.mediaKind,
    attachmentType: params.attachmentType,
  });
  return {
    mediaType: fallbackType,
    canonicalUrl: formatCanonicalInstagramUrl(params.shortcode, fallbackType, existingHint),
  };
}
