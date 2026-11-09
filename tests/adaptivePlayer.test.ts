import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../public/playerGeometry.js';
import {
  isAllowedInstagramMediaHost,
  isValidShortcode,
  parseEfgMediaKind,
  parseImageDimensionsFromBuffer,
} from '../src/services/reelMetadataResolver.ts';

const ReelerGeometry = (globalThis as any).ReelerGeometry;

function makeEfgUrl(tag, { urlSafe = false, encodeAmp = false } = {}) {
  const b64 = Buffer.from(JSON.stringify({ vencode_tag: tag }), 'utf8').toString('base64');
  const encoded = urlSafe ? b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : encodeURIComponent(b64);
  const sep = encodeAmp ? '&amp;' : '&';
  return `https://scontent.cdninstagram.com/v/t51.82787-15/img.jpg?stp=dst-jpg${sep}efg=${encoded}${sep}oe=ABCDEF`;
}

test('playerGeometry.parseThumbMeta decodes CLIPS, FEED, CAROUSEL_ITEM and malformed URLs', () => {
  assert.deepEqual(ReelerGeometry.parseThumbMeta(makeEfgUrl('CLIPS.best_image_urlgen.C3', { encodeAmp: true })), {
    mediaKind: 'CLIPS',
    isClips: true,
  });
  assert.deepEqual(ReelerGeometry.parseThumbMeta(makeEfgUrl('FEED.xpids.1080.sdr.regular_photo.C2')), {
    mediaKind: 'FEED',
    isClips: false,
  });
  assert.deepEqual(ReelerGeometry.parseThumbMeta(makeEfgUrl('CAROUSEL_ITEM.xpids.3464', { urlSafe: true })), {
    mediaKind: 'CAROUSEL_ITEM',
    isClips: false,
  });
  assert.deepEqual(ReelerGeometry.parseThumbMeta(null), { mediaKind: 'UNKNOWN', isClips: null });
  assert.deepEqual(ReelerGeometry.parseThumbMeta('https://example.com/no-efg.jpg'), { mediaKind: 'UNKNOWN', isClips: null });
});

test('playerGeometry.parseEmbedMessage and computeEmbedRatioFromHeights guard stale/invalid inputs', () => {
  assert.deepEqual(
    ReelerGeometry.parseEmbedMessage(JSON.stringify({ type: 'MEASURE', details: { height: 548 } })),
    { type: 'MEASURE', height: 548 }
  );
  assert.equal(ReelerGeometry.parseEmbedMessage('not-json'), null);

  // Valid deltas across real ratios
  assert.equal(ReelerGeometry.computeEmbedRatioFromHeights(320, 610, 520, 860), 0.8); // 4:5 (dH=250)
  assert.equal(ReelerGeometry.computeEmbedRatioFromHeights(320, 528, 520, 728), 1.0); // 1:1 (dH=200)
  assert.equal(ReelerGeometry.computeEmbedRatioFromHeights(320, 388, 520, 500), 1.7857); // ~16:9 (dH=112)

  // Guard stale W1 / divide-by-zero / negative / NaN
  assert.equal(ReelerGeometry.computeEmbedRatioFromHeights(320, 548, 520, 548), null);
  assert.equal(ReelerGeometry.computeEmbedRatioFromHeights(320, 548, 520, 560), null);
  assert.equal(ReelerGeometry.computeEmbedRatioFromHeights(320, 548, 320, 748), null);
  assert.equal(ReelerGeometry.computeEmbedRatioFromHeights(320, Number.NaN, 520, 748), null);
});

test('playerGeometry.classifyPostAspect disambiguates pillarboxed 9:16 Reels vs genuine 4:5 FEED posts', () => {
  // 9:16 Reel inside 4:5 Instagram container
  const reel = ReelerGeometry.classifyPostAspect({
    embedRatio: 0.8,
    isClips: true,
    thumbAspectRatio: 0.563,
  });
  assert.equal(reel.isPillarboxedReel, true);
  assert.ok(Math.abs(reel.displayRatio - 9 / 16) < 0.001);

  // Genuine 4:5 FEED photo (same 0.80 embed ratio, must NOT be cropped!)
  const photo45 = ReelerGeometry.classifyPostAspect({
    embedRatio: 0.8,
    isClips: false,
    thumbAspectRatio: 1.0, // even with square OG preview!
  });
  assert.equal(photo45.isPillarboxedReel, false);
  assert.equal(photo45.displayRatio, 0.8);

  // Native 4:5 CLIPS video (rare, thumb matches ~4:5 -> must NOT crop)
  const reel45 = ReelerGeometry.classifyPostAspect({
    embedRatio: 0.8,
    isClips: true,
    thumbAspectRatio: 0.8,
  });
  assert.equal(reel45.isPillarboxedReel, false);
  assert.equal(reel45.displayRatio, 0.8);

  // 16:9 Landscape Reel (`CLIPS`, embedRatio = 1.778)
  const landscapeReel = ReelerGeometry.classifyPostAspect({
    embedRatio: 1.778,
    isClips: true,
    thumbAspectRatio: 1.778,
  });
  assert.equal(landscapeReel.isPillarboxedReel, false);
  assert.equal(landscapeReel.displayRatio, 1.778);

  // Pre-probe / fallback classification uses cover thumb ratio without cropping feed photos or exposing white chrome
  const preProbeSquare = ReelerGeometry.classifyPostAspect({
    embedRatio: null,
    isClips: false,
    thumbAspectRatio: 1.0,
  });
  assert.equal(preProbeSquare.isPillarboxedReel, false);
  assert.equal(preProbeSquare.displayRatio, 1.0);
  assert.equal(preProbeSquare.effectiveEmbedRatio, 1.0);

  const preProbeVerticalUnknown = ReelerGeometry.classifyPostAspect({
    embedRatio: null,
    isClips: null,
    thumbAspectRatio: 0.563,
  });
  assert.equal(preProbeVerticalUnknown.isPillarboxedReel, true);
  assert.equal(preProbeVerticalUnknown.effectiveEmbedRatio, 0.8);
});

test('playerGeometry.computeAdaptiveStage fits all aspect ratios on Desktop and Mobile with 0 white bleed', () => {
  const cases = [
    { name: '9:16 Desktop', embedRatio: 0.8, isClips: true, thumbAspectRatio: 0.563, vw: 1440, vh: 900, expectDocked: false, expectCompact: false },
    { name: '3:4 Desktop', embedRatio: 0.755, isClips: false, thumbAspectRatio: null, vw: 1440, vh: 900, expectDocked: true, expectCompact: false },
    { name: '1:1 Desktop', embedRatio: 1.0, isClips: false, thumbAspectRatio: null, vw: 1440, vh: 900, expectDocked: true, expectCompact: false },
    { name: '5:4 Desktop', embedRatio: 1.25, isClips: false, thumbAspectRatio: null, vw: 1440, vh: 900, expectDocked: true, expectCompact: false },
    { name: '16:9 Desktop', embedRatio: 1.778, isClips: true, thumbAspectRatio: 1.778, vw: 1440, vh: 900, expectDocked: true, expectCompact: false },
    { name: '9:16 Mobile', embedRatio: 0.8, isClips: true, thumbAspectRatio: 0.563, vw: 390, vh: 844, expectDocked: false, expectCompact: false },
    { name: '1:1 Mobile', embedRatio: 1.0, isClips: false, thumbAspectRatio: null, vw: 390, vh: 844, expectDocked: true, expectCompact: true },
    { name: '16:9 Mobile', embedRatio: 1.778, isClips: true, thumbAspectRatio: 1.778, vw: 390, vh: 844, expectDocked: true, expectCompact: true },
  ];

  for (const c of cases) {
    const st = ReelerGeometry.computeAdaptiveStage({
      embedRatio: c.embedRatio,
      isClips: c.isClips,
      thumbAspectRatio: c.thumbAspectRatio,
      viewportWidth: c.vw,
      viewportHeight: c.vh,
    });
    assert.equal(st.useDockedMeta, c.expectDocked, `${c.name} useDockedMeta`);
    assert.equal(st.useCompactRail, c.expectCompact, `${c.name} useCompactRail`);
    assert.equal(st.iframeTop, -55, `${c.name} must clip 54px header + 1px safety`);
    assert.ok(st.viewW <= c.vw - 16, `${c.name} viewW ${st.viewW} fits viewport ${c.vw}`);
    assert.ok(st.viewH <= c.vh - 66, `${c.name} viewH ${st.viewH} fits viewport ${c.vh}`);

    const renderedMediaH = Math.round((st.iframeW - 2) / st.effectiveEmbedRatio);
    assert.ok(st.viewH <= renderedMediaH - 2, `${c.name} viewport height ${st.viewH} stays strictly inside media height ${renderedMediaH}`);
  }
});

test('reelMetadataResolver parses PNG, GIF, JPEG SOF0/SOF2, WebP, shortcodes, and CDN hosts', () => {
  assert.equal(isValidShortcode('Dew5KTsN4Y8'), true);
  assert.equal(isValidShortcode('DeaT_CGNH-q'), true);
  assert.equal(isValidShortcode('../etc/passwd'), false);
  assert.equal(isValidShortcode('ab'), false);

  assert.equal(isAllowedInstagramMediaHost('https://scontent-lax3-1.cdninstagram.com/v/img.jpg'), true);
  assert.equal(isAllowedInstagramMediaHost('https://instagram.fbom3-2.fna.fbcdn.net/v/img.jpg'), true);
  assert.equal(isAllowedInstagramMediaHost('http://scontent.cdninstagram.com/v/img.jpg'), false);
  assert.equal(isAllowedInstagramMediaHost('https://127.0.0.1/img.jpg'), false);
  assert.equal(isAllowedInstagramMediaHost('https://evil.com/cdninstagram.com/img.jpg'), false);

  assert.deepEqual(parseEfgMediaKind(makeEfgUrl('CLIPS.best_image_urlgen.C3')), {
    mediaKind: 'CLIPS',
    isClips: true,
  });

  // Synthetic PNG 360x640
  const png = Buffer.alloc(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(360, 16);
  png.writeUInt32BE(640, 20);
  assert.deepEqual(parseImageDimensionsFromBuffer(png), { width: 360, height: 640 });

  // Synthetic GIF 500x400
  const gif = Buffer.from('GIF89a\xf4\x01\x90\x01', 'latin1');
  assert.deepEqual(parseImageDimensionsFromBuffer(gif), { width: 500, height: 400 });

  // Synthetic JPEG SOF2 1080x1920
  const jpg = Buffer.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc2, 0x00, 0x0b, 0x08, 0x07, 0x80, 0x04, 0x38, 0x03, 0x01, 0x22, 0x00,
  ]);
  assert.deepEqual(parseImageDimensionsFromBuffer(jpg), { width: 1080, height: 1920 });

  // Synthetic WebP VP8L 720x1280 (stored w-1=719, h-1=1279)
  const webp = Buffer.alloc(26);
  webp.write('RIFF', 0, 'ascii');
  webp.write('WEBPVP8L', 8, 'ascii');
  webp[20] = 0x2f;
  webp.writeUInt32LE(719 | (1279 << 14), 21);
  assert.deepEqual(parseImageDimensionsFromBuffer(webp), { width: 720, height: 1280 });

  // Truncated / unknown
  assert.equal(parseImageDimensionsFromBuffer(Buffer.from([1, 2, 3])), null);
});
