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
    const rawTitle = html.match(/<meta property="og:title" content="([^"]+)"/i)?.[1] || '';
    const rawDesc = html.match(/<meta property="og:description" content="([^"]+)"/i)?.[1] || '';
    const ogImage = html.match(/<meta property="og:image" content="([^"]+)"/i)?.[1];

    const ogTitle = decodeHtml(rawTitle);
    const ogDesc = decodeHtml(rawDesc);

    // Format 1: "... comments - username on date:"
    let username = ogDesc.match(/comments\s*-\s*@?([a-zA-Z0-9._]+)\s+on/i)?.[1];
    
    // Format 2: "... - @username on date"
    if (!username) {
      username = ogDesc.match(/-\s*@([a-zA-Z0-9._]+)\s+on/i)?.[1];
    }

    // Format 3: "@username on Instagram"
    if (!username) {
      username = ogTitle.match(/@([a-zA-Z0-9._]+)/)?.[1];
    }

    // Extract display name (e.g. "Name | Category on Instagram: ...")
    const displayNameMatch = ogTitle.match(/^(.+?)\s+on Instagram/i);
    const displayName = displayNameMatch ? displayNameMatch[1].trim() : (username || 'Instagram Creator');

    // Extract clean caption (strip the header/footer from ogDesc)
    let caption = ogDesc;
    const captionQuoteMatch = ogDesc.match(/: "([\s\S]+?)"\.?\s*$/);
    if (captionQuoteMatch) {
      caption = captionQuoteMatch[1];
    }

    return {
      username: username?.toLowerCase(),
      displayName,
      caption,
      thumbnailUrl: ogImage,
    };
  } catch (e: any) {
    console.error(`[MetadataResolver] Failed to resolve shortcode ${shortcode}:`, e.message);
    return {};
  }
}
