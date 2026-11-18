import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../public/playerGeometry.js';
import {
  feedMetaCacheControl,
  fetchReelMetadata,
  isAllowedInstagramMediaHost,
  isValidShortcode,
  parseEfgMediaKind,
  parseImageDimensionsFromBuffer,
  readImageDimensionsFromStream,
  resetFeedMetaResolverStateForTests,
  resolveFeedMediaMetadata,
} from '../src/services/reelMetadataResolver.ts';
import {
  isPostgrestRangeNotSatisfiableError,
  sanitizePostgrestSearchTerm,
} from '../src/db/repository.ts';

const ReelerGeometry = (globalThis as any).ReelerGeometry;

/**
 * Constructs a synthetic Instagram CDN image URL containing an encoded `efg` metadata payload.
 */
function makeEfgUrl(tag: string, { urlSafe = false, encodeAmp = false } = {}) {
  const b64 = Buffer.from(JSON.stringify({ vencode_tag: tag }), 'utf8').toString('base64');
  const encoded = urlSafe ? b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : encodeURIComponent(b64);
  const sep = encodeAmp ? '&amp;' : '&';
  return `https://scontent.cdninstagram.com/v/t51.82787-15/img.jpg?stp=dst-jpg${sep}efg=${encoded}${sep}oe=ABCDEF`;
}

/**
 * Creates a synthetic PNG header buffer with explicit pixel dimensions.
 */
function makePngBytes(width: number, height: number, totalSize: number = 24): Uint8Array {
  const png = Buffer.alloc(Math.max(24, totalSize));
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

/**
 * Builds a ReadableStream yielding fixed chunks and tracking pull counts and reader cancellation.
 */
function makeTrackedChunkStream(chunks: Uint8Array[]) {
  let index = 0;
  let canceled = false;
  let pulled = 0;

  const stream = new ReadableStream<Uint8Array>({
    /**
     * Enqueues the next chunk or closes when exhausted.
     */
    pull(controller) {
      pulled++;
      if (index < chunks.length) {
        controller.enqueue(chunks[index++]);
      } else {
        controller.close();
      }
    },
    /**
     * Records stream cancellation when the reader aborts or exits.
     */
    cancel() {
      canceled = true;
    },
  });

  return {
    stream,
    /**
     * Returns whether the stream was canceled and how many chunks were pulled.
     */
    stats: () => ({ canceled, pulled }),
  };
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

test('playerGeometry.computeAdaptiveStage fits all aspect ratios on Desktop, Mobile, 320x568 SE, and 700x500 landscape with 0 white bleed', () => {
  const cases = [
    { name: '9:16 Desktop', embedRatio: 0.8, isClips: true, thumbAspectRatio: 0.563, vw: 1440, vh: 900, expectDocked: false, expectCompact: false, expectSideDock: false },
    { name: '3:4 Desktop', embedRatio: 0.755, isClips: false, thumbAspectRatio: null, vw: 1440, vh: 900, expectDocked: true, expectCompact: false, expectSideDock: false },
    { name: '1:1 Desktop', embedRatio: 1.0, isClips: false, thumbAspectRatio: null, vw: 1440, vh: 900, expectDocked: true, expectCompact: false, expectSideDock: false },
    { name: '5:4 Desktop', embedRatio: 1.25, isClips: false, thumbAspectRatio: null, vw: 1440, vh: 900, expectDocked: true, expectCompact: false, expectSideDock: false },
    { name: '16:9 Desktop', embedRatio: 1.778, isClips: true, thumbAspectRatio: 1.778, vw: 1440, vh: 900, expectDocked: true, expectCompact: false, expectSideDock: false },
    { name: '9:16 Mobile', embedRatio: 0.8, isClips: true, thumbAspectRatio: 0.563, vw: 390, vh: 844, expectDocked: false, expectCompact: false, expectSideDock: false },
    { name: '1:1 Mobile', embedRatio: 1.0, isClips: false, thumbAspectRatio: null, vw: 390, vh: 844, expectDocked: true, expectCompact: true, expectSideDock: false },
    { name: '16:9 Mobile', embedRatio: 1.778, isClips: true, thumbAspectRatio: 1.778, vw: 390, vh: 844, expectDocked: true, expectCompact: true, expectSideDock: false },
    { name: '9:16 SE 320x568', embedRatio: 0.8, isClips: true, thumbAspectRatio: 0.563, vw: 320, vh: 568, expectDocked: false, expectCompact: false, expectSideDock: false },
    { name: '1:1 SE 320x568', embedRatio: 1.0, isClips: false, thumbAspectRatio: null, vw: 320, vh: 568, expectDocked: true, expectCompact: true, expectSideDock: false },
    { name: '9:16 Short 700x500', embedRatio: 0.8, isClips: true, thumbAspectRatio: 0.563, vw: 700, vh: 500, expectDocked: false, expectCompact: false, expectSideDock: true },
    { name: '1:1 Short 700x500', embedRatio: 1.0, isClips: false, thumbAspectRatio: null, vw: 700, vh: 500, expectDocked: false, expectCompact: false, expectSideDock: true },
    { name: '16:9 Short 700x500', embedRatio: 1.778, isClips: true, thumbAspectRatio: 1.778, vw: 700, vh: 500, expectDocked: false, expectCompact: false, expectSideDock: true },
  ];

  for (const c of cases) {
    const st = ReelerGeometry.computeAdaptiveStage({
      embedRatio: c.embedRatio,
      isClips: c.isClips,
      thumbAspectRatio: c.thumbAspectRatio,
      viewportWidth: c.vw,
      viewportHeight: c.vh,
    });
    assert.equal(st.useSideDock, c.expectSideDock, `${c.name} useSideDock`);
    assert.equal(st.useDockedMeta, c.expectDocked, `${c.name} useDockedMeta`);
    assert.equal(st.useCompactRail, c.expectCompact, `${c.name} useCompactRail`);
    assert.equal(st.iframeTop, -55, `${c.name} must clip 54px header + 1px safety`);
    assert.ok(st.viewW <= c.vw - 16, `${c.name} viewW ${st.viewW} fits viewport ${c.vw}`);
    assert.ok(st.controlsW >= st.viewW, `${c.name} controlsW ${st.controlsW} >= viewW ${st.viewW}`);
    assert.ok(st.controlsW <= c.vw - 16, `${c.name} controlsW ${st.controlsW} fits viewport ${c.vw}`);
    assert.ok(st.viewH <= c.vh - 66, `${c.name} viewH ${st.viewH} fits viewport ${c.vh}`);

    if (c.expectSideDock) {
      assert.ok(st.sideDockMetaW >= 196 && st.sideDockMetaW <= 256, `${c.name} sideDockMetaW ${st.sideDockMetaW} bounded`);
      assert.ok(st.viewW + st.sideDockMetaW + 124 <= c.vw, `${c.name} side-dock total fits viewport ${c.vw} with 0px overflow`);
      if (c.name === '9:16 Short 700x500') {
        assert.ok(st.viewW >= 220 && st.viewH >= 400, `${c.name} renders full-height stage (${st.viewW}x${st.viewH}) instead of collapsed square`);
      }
    }

    if (c.expectCompact) {
      const expectedMinControls = Math.min(c.vw - 32, 380);
      assert.ok(st.controlsW >= Math.min(c.vw - 32, expectedMinControls), `${c.name} compact controlsW must not collapse`);
    }

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
  assert.deepEqual(parseImageDimensionsFromBuffer(makePngBytes(360, 640)), { width: 360, height: 640 });

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

test('readImageDimensionsFromStream cancels stream reader on early match, EOF, error, and probe limit', async () => {
  // 1. Multi-chunk match cancels early before trailing megabyte chunks are pulled
  const png = makePngBytes(720, 1280);
  const early = makeTrackedChunkStream([
    png.subarray(0, 14),
    png.subarray(14, 24),
    new Uint8Array(64),
    new Uint8Array(64),
  ]);
  const earlyDims = await readImageDimensionsFromStream(early.stream, 512);
  assert.deepEqual(earlyDims, { width: 720, height: 1280 });
  assert.equal(early.stats().canceled, true);
  assert.equal(early.stream.locked, false);
  assert.ok(early.stats().pulled <= 3);

  // 2. Unrecognized stream hitting EOF cancels reader, unlocks stream, and returns null
  const eof = makeTrackedChunkStream([new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6, 7, 8])]);
  const origGetReader = eof.stream.getReader.bind(eof.stream);
  let eofCancelCalls = 0;
  let eofReleaseCalls = 0;
  (eof.stream as any).getReader = () => {
    const reader = origGetReader();
    const origCancel = reader.cancel.bind(reader);
    const origRelease = reader.releaseLock.bind(reader);
    reader.cancel = (...args: any[]) => {
      eofCancelCalls++;
      return origCancel(...args);
    };
    reader.releaseLock = () => {
      eofReleaseCalls++;
      return origRelease();
    };
    return reader;
  };
  const eofDims = await readImageDimensionsFromStream(eof.stream, 512);
  assert.equal(eofDims, null);
  assert.equal(eofCancelCalls, 1);
  assert.equal(eofReleaseCalls, 1);
  assert.equal(eof.stream.locked, false);

  // 3. Stream exceeding maxBytes stops cleanly at limit and cancels reader
  const over = makeTrackedChunkStream([
    new Uint8Array(20),
    new Uint8Array(20),
    new Uint8Array(20),
    new Uint8Array(20),
  ]);
  const overDims = await readImageDimensionsFromStream(over.stream, 32);
  assert.equal(overDims, null);
  assert.equal(over.stats().canceled, true);
  assert.equal(over.stream.locked, false);
  assert.ok(over.stats().pulled <= 3);

  // 4. Reader failure still invokes cancel and releases stream lock
  let errCancelCalls = 0;
  let errReleaseCalls = 0;
  const failingStream = {
    /**
     * Returns a synthetic reader that rejects on read while recording cleanup calls.
     */
    getReader() {
      return {
        /**
         * Simulates a mid-stream network read rejection.
         */
        async read() {
          throw new Error('Synthetic stream reset');
        },
        /**
         * Records reader cancellation during error unwinding.
         */
        async cancel() {
          errCancelCalls++;
        },
        /**
         * Records lock release during error unwinding.
         */
        releaseLock() {
          errReleaseCalls++;
        },
      };
    },
  } as unknown as ReadableStream<Uint8Array>;

  await assert.rejects(() => readImageDimensionsFromStream(failingStream, 64), /Synthetic stream reset/);
  assert.equal(errCancelCalls, 1);
  assert.equal(errReleaseCalls, 1);
});

test('sanitizePostgrestSearchTerm strips PostgREST filter injection characters and preserves handle lookup', () => {
  assert.deepEqual(sanitizePostgrestSearchTerm('@arrakisrunsonduncan'), {
    text: '@arrakisrunsonduncan',
    handle: 'arrakisrunsonduncan',
  });
  assert.deepEqual(sanitizePostgrestSearchTerm('(test,50%_name)'), {
    text: 'test 50\\%\\_name',
    handle: 'test 50\\%\\_name',
  });
  assert.deepEqual(sanitizePostgrestSearchTerm('   '), { text: '', handle: '' });
});

test('feedMetaCacheControl disables browser caching on empty/negative lookups and allows 30m cache on valid lookups', () => {
  assert.equal(
    feedMetaCacheControl({
      shortcode: 'TestEmpty01',
      mediaKind: 'UNKNOWN',
      isClips: null,
      thumbAspectRatio: null,
      thumbnailUrl: null,
    }),
    'no-store'
  );
  assert.equal(
    feedMetaCacheControl({
      shortcode: 'TestClips01',
      mediaKind: 'CLIPS',
      isClips: true,
      thumbAspectRatio: null,
      thumbnailUrl: null,
    }),
    'private, max-age=1800'
  );
  assert.equal(
    feedMetaCacheControl({
      shortcode: 'TestFeed01',
      mediaKind: 'FEED',
      isClips: false,
      thumbAspectRatio: null,
      thumbnailUrl: 'https://scontent.cdninstagram.com/v/img.jpg',
    }),
    'private, max-age=1800'
  );
});

test('resolveFeedMediaMetadata discards aborted in-flight entries so subsequent callers start a fresh lookup', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;

  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    fetchCalls++;
    const attempt = fetchCalls;
    const signal = init?.signal;

    if (attempt === 1) {
      return await new Promise<Response>((_resolve, reject) => {
        if (signal?.aborted) {
          const abortErr = new Error('Aborted');
          abortErr.name = 'AbortError';
          reject(abortErr);
          return;
        }
        signal?.addEventListener('abort', () => {
          const abortErr = new Error('Aborted');
          abortErr.name = 'AbortError';
          reject(abortErr);
        }, { once: true });
      });
    }

    const html = '<meta property="og:url" content="https://www.instagram.com/p/AbCde12345/"><meta property="og:title" content="@demo on Instagram">';
    return new Response(html, {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  }) as typeof fetch;

  try {
    resetFeedMetaResolverStateForTests();
    const firstCtrl = new AbortController();
    const firstPromise = resolveFeedMediaMetadata('AbCde12345', firstCtrl.signal);
    await new Promise((r) => setTimeout(r, 10));
    firstCtrl.abort();
    await assert.rejects(() => firstPromise, (err: any) => err?.name === 'AbortError');

    const secondCtrl = new AbortController();
    const secondResult = await resolveFeedMediaMetadata('AbCde12345', secondCtrl.signal);
    assert.equal(fetchCalls, 2);
    assert.equal(secondResult.shortcode, 'AbCde12345');
    assert.equal(secondResult.isClips, false);
    assert.equal(secondResult.mediaKind, 'FEED');
  } finally {
    resetFeedMetaResolverStateForTests();
    globalThis.fetch = originalFetch;
  }
});

test('resolveFeedMediaMetadata enforces upstream per-minute budget while allowing cache hits', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async (url: unknown) => {
    fetchCalls++;
    const match = String(url).match(/\/(?:reel|p)\/([A-Za-z0-9_-]+)\//);
    const sc = match?.[1] || 'Demo01';
    const html = `<meta property="og:url" content="https://www.instagram.com/reel/${sc}/"><meta property="og:title" content="@demo on Instagram">`;
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
  }) as typeof fetch;

  try {
    resetFeedMetaResolverStateForTests();
    for (let i = 0; i < 120; i++) {
      await resolveFeedMediaMetadata(`RateCap${String(i).padStart(3, '0')}`);
    }
    assert.equal(fetchCalls, 120);

    // Cached entry succeeds without consuming upstream budget or calling fetch
    const cached = await resolveFeedMediaMetadata('RateCap000');
    assert.equal(cached.shortcode, 'RateCap000');
    assert.equal(fetchCalls, 120);

    // 121st distinct uncached shortcode in the same minute is rate-limited
    await assert.rejects(
      () => resolveFeedMediaMetadata('RateCap999'),
      (err: any) => err?.code === 'RATE_LIMITED'
    );
  } finally {
    resetFeedMetaResolverStateForTests();
    globalThis.fetch = originalFetch;
  }
});

test('isPostgrestRangeNotSatisfiableError recognizes PostgREST PGRST103 and HTTP 416 range errors only', () => {
  assert.equal(
    isPostgrestRangeNotSatisfiableError({ code: 'PGRST103', message: 'Requested range not satisfiable' }),
    true
  );
  assert.equal(isPostgrestRangeNotSatisfiableError({ status: 416, message: 'Range Not Satisfiable' }), true);
  assert.equal(isPostgrestRangeNotSatisfiableError({ message: 'Requested range not satisfiable' }), true);
  assert.equal(isPostgrestRangeNotSatisfiableError({ code: '42P01', message: 'relation does not exist' }), false);
  assert.equal(isPostgrestRangeNotSatisfiableError(null), false);
});

test('fetchReelMetadata and resolveFeedMediaMetadata prioritize /p/ when hinted and fall back cleanly', async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];

  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    requestedUrls.push(u);

    if (u === 'https://www.instagram.com/p/DS1goOmjhUi/') {
      const html = [
        '<meta property="og:url" content="https://www.instagram.com/the_political_compass/p/DS1goOmjhUi/">',
        '<meta property="og:title" content="The Political Compass (@the_political_compass) on Instagram">',
        '<meta property="og:image" content="https://scontent.cdninstagram.com/v/t51.2885-15/post.jpg">',
      ].join('');
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
    }

    if (u === 'https://www.instagram.com/reel/DS1goOmjhUi/') {
      return new Response('<html><title>Page not found</title></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }

    return new Response('', { status: 404 });
  }) as typeof fetch;

  try {
    resetFeedMetaResolverStateForTests();

    // 1. When hinted with 'p', probes /p/ directly in 1 fetch call without hitting /reel/
    const directPostMeta = await fetchReelMetadata('DS1goOmjhUi', undefined, 'p');
    assert.deepEqual(requestedUrls, ['https://www.instagram.com/p/DS1goOmjhUi/']);
    assert.equal(directPostMeta.username, 'the_political_compass');
    assert.equal(directPostMeta.isClips, false);
    assert.equal(directPostMeta.mediaKind, 'FEED');

    // 2. When hinted with 'reel', skips non-OG shell on /reel/ and falls back to /p/
    requestedUrls.length = 0;
    const fallbackPostMeta = await fetchReelMetadata('DS1goOmjhUi', undefined, 'reel');
    assert.deepEqual(requestedUrls, [
      'https://www.instagram.com/reel/DS1goOmjhUi/',
      'https://www.instagram.com/p/DS1goOmjhUi/',
    ]);
    assert.equal(fallbackPostMeta.username, 'the_political_compass');
    assert.equal(fallbackPostMeta.isClips, false);

    // 3. resolveFeedMediaMetadata('DS1goOmjhUi', undefined, 'p') resolves FEED / isClips=false
    requestedUrls.length = 0;
    const feedMeta = await resolveFeedMediaMetadata('DS1goOmjhUi', undefined, 'p');
    assert.deepEqual(requestedUrls, ['https://www.instagram.com/p/DS1goOmjhUi/']);
    assert.equal(feedMeta.isClips, false);
    assert.equal(feedMeta.mediaKind, 'FEED');
    assert.equal(feedMeta.thumbnailUrl, 'https://scontent.cdninstagram.com/v/t51.2885-15/post.jpg');
  } finally {
    resetFeedMetaResolverStateForTests();
    globalThis.fetch = originalFetch;
  }
});

test('resolveFeedMediaMetadata prevents a delayed ordinary lookup from overwriting refreshed cache', async () => {
  const originalFetch = globalThis.fetch;
  const origMetaProxy = process.env.METADATA_PROXY_URL;
  delete process.env.METADATA_PROXY_URL;

  let callCount = 0;
  let releaseOrdinaryFetch!: () => void;
  const ordinaryFetchStarted = new Promise<void>((resolve) => {
    globalThis.fetch = (async () => {
      callCount++;
      if (callCount === 1) {
        resolve();
        await new Promise<void>((r) => {
          releaseOrdinaryFetch = r;
        });
        return new Response(
          '<html><head>' +
            '<meta property="og:url" content="https://www.instagram.com/p/RefreshRace1/" />' +
            '<meta property="og:image" content="https://scontent.cdninstagram.com/v/stale-cover.jpg" />' +
            '</head></html>',
          { status: 200, headers: { 'content-type': 'text/html' } }
        );
      }
      return new Response(
        '<html><head>' +
          '<meta property="og:url" content="https://www.instagram.com/p/RefreshRace1/" />' +
          '<meta property="og:image" content="https://scontent.cdninstagram.com/v/fresh-cover.jpg" />' +
          '</head></html>',
        { status: 200, headers: { 'content-type': 'text/html' } }
      );
    }) as typeof fetch;
  });

  try {
    resetFeedMetaResolverStateForTests();

    const ordinaryPromise = resolveFeedMediaMetadata('RefreshRace1', undefined, 'p', false);
    await ordinaryFetchStarted;

    // Refresh starts and commits while the ordinary lookup is still in flight
    const refreshed = await resolveFeedMediaMetadata('RefreshRace1', undefined, 'p', true);
    assert.equal(refreshed.thumbnailUrl, 'https://scontent.cdninstagram.com/v/fresh-cover.jpg');

    // Now let the delayed ordinary lookup finish
    releaseOrdinaryFetch();
    const ordinaryResult = await ordinaryPromise;
    assert.equal(
      ordinaryResult.thumbnailUrl,
      'https://scontent.cdninstagram.com/v/stale-cover.jpg',
      'Ordinary lookup still returns its resolved result to its existing caller'
    );

    // Subsequent cache hit must return the refreshed cover, not the delayed ordinary response
    const cachedAfterRace = await resolveFeedMediaMetadata('RefreshRace1', undefined, 'p', false);
    assert.equal(
      cachedAfterRace.thumbnailUrl,
      'https://scontent.cdninstagram.com/v/fresh-cover.jpg',
      'Delayed ordinary lookup must not overwrite newer refreshed cache metadata'
    );
    assert.equal(callCount, 2, 'Subsequent lookup should be served from refreshed cache');
  } finally {
    resetFeedMetaResolverStateForTests();
    globalThis.fetch = originalFetch;
    if (origMetaProxy === undefined) delete process.env.METADATA_PROXY_URL;
    else process.env.METADATA_PROXY_URL = origMetaProxy;
  }
});
