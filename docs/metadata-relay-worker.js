/**
 * Optional Cloudflare Worker relay for Reeler OpenGraph metadata lookups.
 *
 * Deploy on Cloudflare Workers (free tier) and set on Render:
 *   METADATA_PROXY_URL=https://<your-worker>.workers.dev/
 *   METADATA_PROXY_TOKEN=<same secret configured in Worker env.RELAY_TOKEN>
 *
 * Strictly allows only public Instagram /reel/<shortcode>/ and /p/<shortcode>/ URLs.
 */

const ALLOWED_PATH_RE = /^\/(?:reel|p)\/[A-Za-z0-9_-]{5,32}\/?$/;
const OG_META_RE = /<meta\s+(?:property|name)="(?:og:url|og:image|twitter:title|og:title)"/i;
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

    if (
      targetUrl.protocol !== 'https:' ||
      targetUrl.hostname !== 'www.instagram.com' ||
      !ALLOWED_PATH_RE.test(targetUrl.pathname)
    ) {
      return new Response('Unsupported target URL', { status: 400 });
    }

    for (const userAgent of USER_AGENTS) {
      const upstream = await fetch(targetUrl.toString(), {
        headers: {
          'User-Agent': userAgent,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        redirect: 'follow',
      });
      if (!upstream.ok) {
        continue;
      }
      const html = await upstream.text();
      if (OG_META_RE.test(html)) {
        return new Response(html, {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'private, max-age=300',
          },
        });
      }
    }

    return new Response('No OpenGraph metadata available', { status: 502 });
  },
};
