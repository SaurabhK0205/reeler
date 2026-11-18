/**
 * Optional Cloudflare Worker relay for Reeler OpenGraph metadata lookups.
 *
 * Deploy on Cloudflare Workers (free tier) and set on Render:
 *   METADATA_PROXY_URL=https://<your-worker>.workers.dev/
 *   METADATA_PROXY_TOKEN=<same secret configured in Worker env.RELAY_TOKEN>
 *
 * Strictly allows only public Instagram /reel/<shortcode>/ and /p/<shortcode>/ URLs
 * matching the requested shortcode across both the initial request and redirect hops (CWE-918 mitigation).
 */

const ALLOWED_PATH_RE = /^\/(?:reel|p)\/([A-Za-z0-9_-]{5,32})\/?$/;
const OG_ITEM_SHORTCODE_RE = /instagram\.com\/(?:[^/?#]+\/)?(?:reel|reels|p|tv)\/([A-Za-z0-9_-]{5,32})(?:[/?#]|$)/i;
const GENERIC_INSTAGRAM_TITLE_RE = /^(?:instagram|login\s*[•·-]\s*instagram)$/i;
const MAX_REDIRECT_HOPS = 3;
const MAX_HTML_BYTES = 1_500_000;
// Shared relay deadline fits within the app resolver's 8s timeout while keeping primary eligible if slow
const SHARED_RELAY_TIMEOUT_MS = 7200;
const SECONDARY_HEDGE_DELAY_MS = 2500;
const USER_AGENTS = [
  'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  'WhatsApp/2.23.20.0',
];

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function decodeHtmlAttribute(value) {
  return value
    .replace(/&#064;/g, '@')
    .replace(/&#x40;/g, '@')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function isAllowedInstagramUrl(parsed, expectedShortcode) {
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'www.instagram.com') {
    return false;
  }
  const match = parsed.pathname.match(ALLOWED_PATH_RE);
  if (!match) {
    return false;
  }
  return !expectedShortcode || match[1] === expectedShortcode;
}

/**
 * Quote-aware `<meta>` tokenizer supporting `>` inside quoted values, arbitrary attribute order,
 * and double-quoted, single-quoted, or unquoted attribute values.
 */
function extractMetaTagAttributes(html) {
  const tags = [];
  const lower = html.toLowerCase();
  let pos = 0;

  while (pos < html.length) {
    const start = lower.indexOf('<meta', pos);
    if (start === -1) break;
    const afterName = html[start + 5];
    if (afterName && !/[\s/>]/.test(afterName)) {
      pos = start + 5;
      continue;
    }

    let i = start + 5;
    const attrs = Object.create(null);

    while (i < html.length) {
      while (i < html.length && /[\s/]/.test(html[i])) i++;
      if (i >= html.length || html[i] === '>') {
        i++;
        break;
      }

      const nameStart = i;
      while (i < html.length && !/[\s=/>]/.test(html[i])) i++;
      const attrName = html.slice(nameStart, i).toLowerCase();
      while (i < html.length && /\s/.test(html[i])) i++;

      let attrVal = '';
      if (i < html.length && html[i] === '=') {
        i++;
        while (i < html.length && /\s/.test(html[i])) i++;
        if (i < html.length && (html[i] === '"' || html[i] === "'")) {
          const quote = html[i++];
          const valStart = i;
          while (i < html.length && html[i] !== quote) i++;
          attrVal = html.slice(valStart, i);
          if (i < html.length && html[i] === quote) i++;
        } else {
          const valStart = i;
          while (i < html.length && !/[\s>]/.test(html[i])) i++;
          attrVal = html.slice(valStart, i);
        }
      }

      if (attrName && !(attrName in attrs)) {
        attrs[attrName] = attrVal;
      }
    }

    tags.push(attrs);
    pos = i;
  }

  return tags;
}

/**
 * Classifies HTML OpenGraph metadata safely across attribute order, quoting styles, and quoted `>`:
 * - 'rich': has og:image or non-generic title and no mismatched og:url shortcode
 * - 'url_only': only has a matching og:url shortcode (held as fallback while other crawler runs)
 * - 'invalid': login wall, missing tags, or mismatched shortcode
 */
function classifyItemOpenGraph(html, shortcode) {
  let ogUrl = '';
  let ogImage = '';
  let twitterTitle = '';
  let ogTitle = '';

  for (const attrs of extractMetaTagAttributes(html)) {
    const contentAttr = attrs.content;
    if (contentAttr === undefined) continue;
    const propertyAttr = (attrs.property || '').toLowerCase();
    const nameAttr = (attrs.name || '').toLowerCase();

    if (propertyAttr === 'og:url' && !ogUrl) ogUrl = decodeHtmlAttribute(contentAttr).trim();
    else if (propertyAttr === 'og:image' && !ogImage) ogImage = decodeHtmlAttribute(contentAttr).trim();
    else if (nameAttr === 'twitter:title' && !twitterTitle) twitterTitle = decodeHtmlAttribute(contentAttr).trim();
    else if (propertyAttr === 'og:title' && !ogTitle) ogTitle = decodeHtmlAttribute(contentAttr).trim();
  }

  let matchedOgUrl = false;
  if (ogUrl) {
    const match = ogUrl.match(OG_ITEM_SHORTCODE_RE);
    if (match && match[1] !== shortcode) {
      return 'invalid';
    }
    if (match && match[1] === shortcode) {
      matchedOgUrl = true;
    }
  }

  const hasRichTitle =
    Boolean(twitterTitle && !GENERIC_INSTAGRAM_TITLE_RE.test(twitterTitle)) ||
    Boolean(ogTitle && !GENERIC_INSTAGRAM_TITLE_RE.test(ogTitle));
  if (ogImage || hasRichTitle) {
    return 'rich';
  }
  return matchedOgUrl ? 'url_only' : 'invalid';
}

async function readBoundedText(response, maxBytes = MAX_HTML_BYTES) {
  if (!response.body) {
    const raw = await response.text();
    return raw.length > maxBytes ? raw.slice(0, maxBytes) : raw;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let output = '';
  let totalBytes = 0;
  try {
    while (totalBytes < maxBytes) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const remaining = maxBytes - totalBytes;
      if (value.byteLength <= remaining) {
        output += decoder.decode(value, { stream: true });
        totalBytes += value.byteLength;
      } else {
        output += decoder.decode(value.subarray(0, remaining), { stream: false });
        totalBytes += remaining;
        break;
      }
    }
    output += decoder.decode();
    return output;
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

async function fetchAllowedInstagramHtml(initialUrl, shortcode, userAgent, signal) {
  let currentUrl = initialUrl;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    if (!isAllowedInstagramUrl(currentUrl, shortcode) || signal.aborted) {
      return null;
    }
    const upstream = await fetch(currentUrl.toString(), {
      signal,
      headers: {
        'User-Agent': userAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'manual',
    });

    if (upstream.status >= 300 && upstream.status < 400) {
      const location = upstream.headers.get('location');
      await upstream.body?.cancel().catch(() => {});
      if (!location || hop === MAX_REDIRECT_HOPS) {
        return null;
      }
      try {
        currentUrl = new URL(location, currentUrl);
      } catch {
        return null;
      }
      continue;
    }

    if (!upstream.ok) {
      await upstream.body?.cancel().catch(() => {});
      return null;
    }

    const html = await readBoundedText(upstream, MAX_HTML_BYTES);
    const quality = classifyItemOpenGraph(html, shortcode);
    if (quality === 'invalid') {
      return null;
    }
    return { html, quality };
  }
  return null;
}

/**
 * Runs primary crawler immediately and hedges the secondary crawler after a short delay (or immediately
 * if primary fails/returns a login shell), returning rich metadata immediately while holding a URL-only
 * result as fallback until both attempts settle or the shared deadline expires.
 */
async function resolveWithHedgedCrawlers(targetUrl, shortcode) {
  const primaryController = new AbortController();
  const secondaryController = new AbortController();
  let hedgeTimer = null;
  let deadlineTimer = null;
  let secondaryStarted = false;

  return new Promise((resolve) => {
    let settled = false;
    let remaining = 2;
    let fallbackHtml = null;

    const finish = (html) => {
      if (settled) return;
      settled = true;
      if (hedgeTimer) clearTimeout(hedgeTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      primaryController.abort();
      secondaryController.abort();
      resolve(html);
    };

    const handleOutcome = (result, isPrimary) => {
      if (settled) return;
      if (result && result.quality === 'rich') {
        finish(result.html);
        return;
      }
      if (result && result.quality === 'url_only' && !fallbackHtml) {
        fallbackHtml = result.html;
      }
      remaining--;
      if (isPrimary) {
        startSecondary();
      }
      if (remaining === 0) {
        finish(fallbackHtml);
      }
    };

    const startSecondary = () => {
      if (secondaryStarted || settled) return;
      secondaryStarted = true;
      if (hedgeTimer) {
        clearTimeout(hedgeTimer);
        hedgeTimer = null;
      }
      fetchAllowedInstagramHtml(targetUrl, shortcode, USER_AGENTS[1], secondaryController.signal)
        .then((res) => handleOutcome(res, false))
        .catch(() => handleOutcome(null, false));
    };

    deadlineTimer = setTimeout(() => finish(fallbackHtml), SHARED_RELAY_TIMEOUT_MS);
    hedgeTimer = setTimeout(startSecondary, SECONDARY_HEDGE_DELAY_MS);

    fetchAllowedInstagramHtml(targetUrl, shortcode, USER_AGENTS[0], primaryController.signal)
      .then((res) => handleOutcome(res, true))
      .catch(() => handleOutcome(null, true));
  });
}

export default {
  async fetch(request, env) {
    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const expectedToken = (env.RELAY_TOKEN || '').trim();
    if (!expectedToken) {
      return new Response('Relay token not configured', { status: 503 });
    }

    const authHeader = request.headers.get('Authorization') || '';
    const providedToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!constantTimeEqual(providedToken, expectedToken)) {
      return new Response('Unauthorized', { status: 401 });
    }

    const reqUrl = new URL(request.url);
    const targetRaw = reqUrl.searchParams.get('url') || '';
    let targetUrl;
    try {
      targetUrl = new URL(targetRaw);
    } catch {
      return new Response('Invalid url parameter', { status: 400 });
    }

    if (!isAllowedInstagramUrl(targetUrl)) {
      return new Response('Unsupported target URL', { status: 400 });
    }

    const shortcodeMatch = targetUrl.pathname.match(ALLOWED_PATH_RE);
    const shortcode = shortcodeMatch ? shortcodeMatch[1] : '';
    const html = await resolveWithHedgedCrawlers(targetUrl, shortcode);
    if (html) {
      return new Response(html, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    }

    return new Response('No OpenGraph metadata available', { status: 502 });
  },
};
