(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.ReelerGeometry = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const PROBE_WIDTH_1 = 320;
  const PROBE_WIDTH_2 = 520;
  const MIN_DELTA_H = 30;
  const MIN_ASPECT = 0.45;
  const MAX_ASPECT = 2.25;
  const HEADER_CLIP_PX = 55;

  /**
   * Decodes base64 (including URL-safe variants) into a UTF-8 string cleanly in browser and Node.
   * @param {string} b64
   * @returns {string}
   */
  function decodeBase64Utf8(b64) {
    const normalized = String(b64).replace(/-/g, '+').replace(/_/g, '/');
    const padLen = (4 - (normalized.length % 4)) % 4;
    const padded = normalized + '='.repeat(padLen);

    if (typeof Buffer === 'function') {
      return Buffer.from(padded, 'base64').toString('utf8');
    }
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  }

  /**
   * Extracts Instagram mediaKind and whether the URL belongs to a CLIPS reel from `efg` metadata.
   * @param {string | null | undefined} urlString
   * @returns {{ mediaKind: 'CLIPS' | 'FEED' | 'CAROUSEL_ITEM' | 'UNKNOWN', isClips: boolean | null }}
   */
  function parseThumbMeta(urlString) {
    if (!urlString) {
      return { mediaKind: 'UNKNOWN', isClips: null };
    }
    try {
      const cleanUrl = String(urlString).replace(/&amp;/g, '&');
      const parsed = new URL(cleanUrl);
      const rawEfg = parsed.searchParams.get('efg');
      if (!rawEfg) {
        return { mediaKind: 'UNKNOWN', isClips: null };
      }
      const jsonStr = decodeBase64Utf8(rawEfg);
      const obj = JSON.parse(jsonStr);
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
    } catch (_) {
      return { mediaKind: 'UNKNOWN', isClips: null };
    }
  }

  /**
   * Parses an incoming Instagram embed postMessage payload into `{ type, height }`.
   * @param {unknown} rawData
   * @returns {{ type: string, height: number | null } | null}
   */
  function parseEmbedMessage(rawData) {
    if (!rawData) return null;
    let data = rawData;
    if (typeof rawData === 'string') {
      try {
        data = JSON.parse(rawData);
      } catch (_) {
        return null;
      }
    }
    if (!data || typeof data !== 'object' || typeof data.type !== 'string') {
      return null;
    }
    const rawH = data.details?.height;
    const height = typeof rawH === 'number' && Number.isFinite(rawH) && rawH > 0 ? rawH : null;
    return { type: data.type, height };
  }

  /**
   * Computes embed media aspect ratio from two width/height measurements.
   * Returns null if delta is too small or invalid (guards against stale W1 messages).
   * @param {number} w1
   * @param {number} h1
   * @param {number} w2
   * @param {number} h2
   * @returns {number | null}
   */
  function computeEmbedRatioFromHeights(w1, h1, w2, h2) {
    if (
      typeof w1 !== 'number' || typeof h1 !== 'number' ||
      typeof w2 !== 'number' || typeof h2 !== 'number' ||
      !Number.isFinite(w1) || !Number.isFinite(h1) ||
      !Number.isFinite(w2) || !Number.isFinite(h2)
    ) {
      return null;
    }
    const dW = w2 - w1;
    const dH = h2 - h1;
    if (dW <= 0 || dH < MIN_DELTA_H) {
      return null;
    }
    const clamped = Math.max(MIN_ASPECT, Math.min(MAX_ASPECT, dW / dH));
    return Math.round(clamped * 10000) / 10000;
  }

  function isValidRatio(val) {
    return typeof val === 'number' && Number.isFinite(val) && val >= MIN_ASPECT && val <= MAX_ASPECT;
  }

  /**
   * Classifies whether the post renders a pillarboxed 9:16 reel inside Instagram's 4:5 embed box
   * or a true-ratio post (`3:4`, `4:5`, `1:1`, `5:4`, `16:9`).
   */
  function classifyPostAspect({ embedRatio = null, isClips = null, thumbAspectRatio = null } = {}) {
    const validThumb = isValidRatio(thumbAspectRatio) ? thumbAspectRatio : null;

    if (isValidRatio(embedRatio)) {
      const isFourFiveEnvelope = embedRatio >= 0.76 && embedRatio <= 0.84;
      if (isFourFiveEnvelope && isClips !== false) {
        if (validThumb !== null) {
          if (validThumb < 0.70) {
            return {
              isPillarboxedReel: true,
              effectiveEmbedRatio: embedRatio,
              displayRatio: 9 / 16,
            };
          }
          return {
            isPillarboxedReel: false,
            effectiveEmbedRatio: embedRatio,
            displayRatio: embedRatio,
          };
        }
        if (isClips === true) {
          return {
            isPillarboxedReel: true,
            effectiveEmbedRatio: embedRatio,
            displayRatio: 9 / 16,
          };
        }
      }
      return {
        isPillarboxedReel: false,
        effectiveEmbedRatio: embedRatio,
        displayRatio: embedRatio,
      };
    }

    // Pre-probe / fallback classification
    if (validThumb !== null) {
      if (isClips !== false && validThumb < 0.70) {
        return {
          isPillarboxedReel: true,
          effectiveEmbedRatio: 0.80,
          displayRatio: validThumb >= 0.50 ? validThumb : 9 / 16,
        };
      }
      if (isClips !== false || validThumb >= 0.70) {
        return {
          isPillarboxedReel: false,
          effectiveEmbedRatio: validThumb,
          displayRatio: validThumb,
        };
      }
    }

    if (isClips === false) {
      return {
        isPillarboxedReel: false,
        effectiveEmbedRatio: 0.80,
        displayRatio: 0.80,
      };
    }

    return {
      isPillarboxedReel: true,
      effectiveEmbedRatio: 0.80,
      displayRatio: 9 / 16,
    };
  }

  /**
   * Computes fitted stage, viewport, overlay dock mode, and exact unscaled iframe coordinates
   * across all aspect ratios (`9:16`, `3:4`, `4:5`, `1:1`, `5:4`, `16:9`) on desktop and mobile.
   */
  function computeAdaptiveStage({
    embedRatio = null,
    isClips = null,
    thumbAspectRatio = null,
    viewportWidth = 1280,
    viewportHeight = 800,
  } = {}) {
    const vw = Math.max(320, Number(viewportWidth) || 1280);
    const vh = Math.max(360, Number(viewportHeight) || 800);
    const isMobile = vw <= 680;

    const classification = classifyPostAspect({ embedRatio, isClips, thumbAspectRatio });
    const { isPillarboxedReel, effectiveEmbedRatio, displayRatio } = classification;

    const useDockedMeta = displayRatio >= 0.70 || vh < 560;
    let useCompactRail = useDockedMeta && (isMobile || vw < 760);

    const topBottomChrome = isMobile ? 66 : 76;

    function fitBox(compactRail) {
      const dockReserveH = !useDockedMeta ? 0 : (compactRail ? 186 : 124);
      const maxW = isMobile
        ? vw - 16
        : (compactRail
          ? Math.min(680, vw - 32)
          : (useDockedMeta ? Math.min(720, vw - 160) : Math.min(430, vw - 160)));
      const maxH = useDockedMeta
        ? Math.max(140, Math.min(640, vh - topBottomChrome - dockReserveH))
        : Math.max(240, Math.min(760, vh - topBottomChrome));

      let viewW = maxW;
      let viewH = Math.round(viewW / displayRatio);
      if (viewH > maxH) {
        viewH = maxH;
        viewW = Math.round(viewH * displayRatio);
      }
      return { viewW, viewH };
    }

    let fitted = fitBox(useCompactRail);
    if (useDockedMeta && !useCompactRail && fitted.viewH < 265) {
      useCompactRail = true;
      fitted = fitBox(true);
    }

    const { viewW, viewH } = fitted;
    const iframeW = isPillarboxedReel
      ? Math.round(viewH * effectiveEmbedRatio) + 2
      : viewW + 2;

    const expectedMediaH = Math.round((iframeW - 2) / effectiveEmbedRatio);
    const bottomSafetyPx = iframeW > 550 ? 4 : 3;
    const viewportHeightPx = Math.max(120, Math.min(viewH, expectedMediaH) - bottomSafetyPx);
    const iframeLeft = isPillarboxedReel ? Math.round((viewW - iframeW) / 2) : -1;
    const iframeTop = -HEADER_CLIP_PX;
    const iframeH = Math.max(900, expectedMediaH + 280);

    return {
      isPillarboxedReel,
      effectiveEmbedRatio,
      displayRatio,
      useDockedMeta,
      useCompactRail,
      viewW,
      viewH: viewportHeightPx,
      iframeW,
      iframeH,
      iframeLeft,
      iframeTop,
    };
  }

  return {
    PROBE_WIDTH_1,
    PROBE_WIDTH_2,
    MIN_DELTA_H,
    HEADER_CLIP_PX,
    parseThumbMeta,
    parseEmbedMessage,
    computeEmbedRatioFromHeights,
    classifyPostAspect,
    computeAdaptiveStage,
  };
});
