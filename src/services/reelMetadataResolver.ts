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

export interface ExtractedReelMetadata {
  username?: string;
  displayName?: string;
  caption?: string;
  thumbnailUrl?: string;
}

export async function fetchReelMetadata(shortcode: string): Promise<ExtractedReelMetadata> {
  try {
    const url = `https://www.instagram.com/reel/${shortcode}/`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (!res.ok) {
      return {};
    }

    const html = await res.text();
    const ogUrl = html.match(/<meta property="og:url" content="([^"]+)"/i)?.[1] || '';
    const rawTwitterTitle = html.match(/<meta name="twitter:title" content="([^"]+)"/i)?.[1] || '';
    const twitterTitle = decodeHtml(rawTwitterTitle);
    const rawTitle = html.match(/<meta property="og:title" content="([^"]+)"/i)?.[1] || '';
    const ogTitle = decodeHtml(rawTitle);
    const rawDesc = html.match(/<meta property="og:description" content="([^"]+)"/i)?.[1] || '';
    const ogDesc = decodeHtml(rawDesc);
    const ogImage = html.match(/<meta property="og:image" content="([^"]+)"/i)?.[1];

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

    return {
      username: username?.toLowerCase(),
      displayName: displayName || username,
      caption,
      thumbnailUrl: ogImage,
    };
  } catch (e: any) {
    console.error(`[MetadataResolver] Failed to resolve shortcode ${shortcode}:`, e.message);
    return {};
  }
}
