/**
 * Optional Cloudflare Worker relay for Reeler OpenGraph metadata lookups.
 *
 * Deploy on Cloudflare Workers (free tier) and set on Render:
 *   METADATA_PROXY_URL=https://<your-worker>.workers.dev/
 *   METADATA_PROXY_TOKEN=<same secret configured in Worker env.RELAY_TOKEN>
 *
 * Strictly allows only public Instagram /reel/<shortcode>/ and /p/<shortcode>/ URLs
 * across both the initial request and any redirect hops (CWE-918 mitigation).
 */

const ALLOWED_PATH_RE = /^\/(?:reel|p)\/[A-Za-z0-9_-]{5,32}\/?$/;
const OG_META_RE = /<meta\s+(?:property|name)="(?:og:url|og:image|twitter:title|og:title)"/i;
const MAX_REDIRECT_HOPS = 3;
const MAX_HTML_BYTES = 1_500_000;
// Bound each attempt so both crawler UAs fit well within the resolver's 8s timeout
const PER_ATTEMPT_TIMEOUT_MS = 3500;
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

function isAllowedInstagramUrl(parsed) {
  return (
    parsed.protocol === 'https:' &&
    parsed.hostname === 'www.instagram.com' &&
    ALLOWED_PATH_RE.test(parsed.pathname)
  );
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

async function fetchAllowedInstagramHtml(initialUrl, userAgent, signal) {
  let currentUrl = initialUrl;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    if (!isAllowedInstagramUrl(currentUrl)) {
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
    return OG_META_RE.test(html) ? html : null;
  }
  return null;
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

    for (const userAgent of USER_AGENTS) {
      try {
        const html = await fetchAllowedInstagramHtml(
          targetUrl,
          userAgent,
          AbortSignal.timeout(PER_ATTEMPT_TIMEOUT_MS)
        );
        if (html) {
          return new Response(html, {
            status: 200,
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
            },
          });
        }
      } catch {
        // Attempt failed or timed out; continue to secondary crawler UA
      }
    }

    return new Response('No OpenGraph metadata available', { status: 502 });
  },
};
