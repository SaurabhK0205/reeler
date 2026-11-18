import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import {
  createRateLimiter,
  safeStringEqual,
  securityHeadersMiddleware,
} from '../src/middleware/security.ts';
import {
  clearIdempotencyStoreForTesting,
  computePayloadFingerprint,
  createIdempotencyMiddleware,
  idempotencyMiddleware,
} from '../src/middleware/idempotency.ts';
import {
  clearOtpRateLimitsForTesting,
  clearOtpsForTesting,
  createOtp,
  generateUserVaultKey,
  getAdminVaultKey,
  requireAdminVaultMiddleware,
  vaultAuthMiddleware,
} from '../src/services/vaultAuthService.ts';
import { apiRouter, resetApiRateLimitersForTesting } from '../src/api/router.ts';
import { MetaInstagramBotService } from '../src/services/metaInstagramBotService.ts';
import { Repository } from '../src/db/repository.ts';

async function withServer<T>(
  app: express.Express,
  fn: (baseUrl: string) => Promise<T>
): Promise<T> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('Security - safeStringEqual performs constant-time comparison across lengths and UTF-8 strings', () => {
  assert.equal(safeStringEqual('abc123', 'abc123'), true);
  assert.equal(safeStringEqual('abc123', 'abc124'), false);
  assert.equal(safeStringEqual('short', 'much-longer-string'), false);
  assert.equal(safeStringEqual('café', 'cafe'), false);
});

test('Security - securityHeadersMiddleware sets CSP, nosniff, frame deny, and HSTS on HTTPS', async () => {
  const app = express();
  app.set('trust proxy', 1);
  app.use(securityHeadersMiddleware);
  app.get('/ping', (_req, res) => res.json({ ok: true }));

  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/ping`, {
      headers: { 'X-Forwarded-Proto': 'https' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.match(res.headers.get('content-security-policy') || '', /script-src 'self'/);
    assert.match(res.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
    assert.match(res.headers.get('strict-transport-security') || '', /max-age=31536000/);
  });
});

test('Security - createRateLimiter enforces limits and evicts oldest keys under IP rotation instead of locking out users', async () => {
  const limiter = createRateLimiter({
    windowMs: 60_000,
    maxRequests: 2,
    maxTrackedKeys: 10,
    errorCode: 'TEST_RATE_LIMITED',
    keyGenerator: (req) => String(req.headers['x-test-ip'] || 'default'),
  });

  const app = express();
  app.use(limiter.middleware);
  app.get('/data', (_req, res) => res.json({ ok: true }));

  await withServer(app, async (baseUrl) => {
    // 1. Standard per-key enforcement
    const r1 = await fetch(`${baseUrl}/data`, { headers: { 'x-test-ip': '10.0.0.1' } });
    const r2 = await fetch(`${baseUrl}/data`, { headers: { 'x-test-ip': '10.0.0.1' } });
    const r3 = await fetch(`${baseUrl}/data`, { headers: { 'x-test-ip': '10.0.0.1' } });
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(r3.status, 429);
    assert.ok(r3.headers.get('retry-after'), '429 must include Retry-After header');
    const body3 = (await r3.json()) as any;
    assert.equal(body3.error, 'TEST_RATE_LIMITED');

    // 2. Flood 25 rotating attacker IPs beyond maxTrackedKeys=10
    for (let i = 0; i < 25; i++) {
      const res = await fetch(`${baseUrl}/data`, { headers: { 'x-test-ip': `198.51.100.${i}` } });
      assert.equal(res.status, 200, 'Rotating IPs must evict oldest entries instead of locking out new visitors');
    }
    assert.ok(limiter.size() <= 10, `Rate limiter map must stay bounded (got ${limiter.size()})`);
  });
});

test('Security - vaultAuthMiddleware rejects spoofed /meta paths and requireAdminVaultMiddleware blocks non-admins before body parsing', async () => {
  const origEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    // 1. Spoofed /meta paths must NOT bypass auth
    for (const spoofPath of ['/stats/meta', '/reels/a/b/meta', '/meta', '/user/meta']) {
      let status = 200;
      const req: any = { path: spoofPath, headers: {}, query: {} };
      const res: any = {
        status: (code: number) => {
          status = code;
          return { json: () => {} };
        },
      };
      let nextCalled = false;
      vaultAuthMiddleware(req, res, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, false, `Spoofed path ${spoofPath} must NOT bypass vaultAuthMiddleware`);
      assert.equal(status, 401);
    }

    // 2. requireAdminVaultMiddleware blocks anonymous (401) and regular user (403) before body parsing
    const app = express();
    let parserCalled = false;
    app.post(
      '/import',
      requireAdminVaultMiddleware,
      (_req, _res, next) => {
        parserCalled = true;
        next();
      },
      (_req, res) => res.json({ imported: true })
    );

    await withServer(app, async (baseUrl) => {
      const anonRes = await fetch(`${baseUrl}/import`, { method: 'POST' });
      assert.equal(anonRes.status, 401);
      assert.equal(parserCalled, false, 'Unauthenticated request must be rejected before body parser');

      const userKey = generateUserVaultKey('non_admin_user');
      const userRes = await fetch(`${baseUrl}/import`, {
        method: 'POST',
        headers: { 'X-Vault-Key': userKey },
      });
      assert.equal(userRes.status, 403);
      assert.equal(parserCalled, false, 'Non-admin user must be rejected before body parser');

      const adminRes = await fetch(`${baseUrl}/import`, {
        method: 'POST',
        headers: { 'X-Vault-Key': getAdminVaultKey() },
      });
      assert.equal(adminRes.status, 200);
      assert.equal(parserCalled, true, 'Verified admin must proceed to body parser');
    });
  } finally {
    process.env.NODE_ENV = origEnv;
  }
});

test('Idempotency - replays deterministic POST/PUT/PATCH responses, rejects conflicts (422), concurrent duplicates (409), malformed keys (400), and isolates principals', async () => {
  clearIdempotencyStoreForTesting();

  // Verify canonical payload fingerprinting ignores key order and preserves own __proto__ keys
  assert.equal(
    computePayloadFingerprint({ a: 1, b: { x: 2, y: 3 } }),
    computePayloadFingerprint({ b: { y: 3, x: 2 }, a: 1 })
  );
  assert.notEqual(
    computePayloadFingerprint(JSON.parse('{"__proto__":[]}')),
    computePayloadFingerprint({}),
    'Own __proto__ keys must not be dropped during canonicalization'
  );

  let executions = 0;
  let shouldFailServer = false;
  let releaseSlowRequest: (() => void) | null = null;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const user = req.headers['x-test-user'];
    if (user === 'admin') req.vaultUser = { role: 'admin' };
    else if (typeof user === 'string') req.vaultUser = { role: 'user', senderId: user };
    next();
  });
  app.use(idempotencyMiddleware);

  app.post('/items', (req, res) => {
    executions++;
    if (shouldFailServer) {
      res.status(500).json({ error: 'TRANSIENT_FAILURE' });
      return;
    }
    res.status(201).json({ execution: executions, echo: req.body });
  });

  app.put('/slow', async (_req, res) => {
    executions++;
    await new Promise<void>((resolve) => {
      releaseSlowRequest = resolve;
    });
    res.status(200).json({ done: true, execution: executions });
  });

  await withServer(app, async (baseUrl) => {
    // 1. Malformed key -> 400
    const badRes = await fetch(`${baseUrl}/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'bad key with spaces' },
      body: JSON.stringify({ name: 'a' }),
    });
    assert.equal(badRes.status, 400);
    assert.equal(((await badRes.json()) as any).error, 'INVALID_IDEMPOTENCY_KEY');

    // 2. First call executes; second call with reordered keys replays exact cached body without re-executing
    const r1 = await fetch(`${baseUrl}/items`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idem-key-001',
        'x-test-user': 'user_a',
      },
      body: JSON.stringify({ first: 1, second: 2 }),
    });
    assert.equal(r1.status, 201);
    assert.equal(r1.headers.get('idempotency-replayed'), null);
    const body1 = (await r1.json()) as any;
    assert.equal(body1.execution, 1);

    const r2 = await fetch(`${baseUrl}/items`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idem-key-001',
        'x-test-user': 'user_a',
      },
      body: JSON.stringify({ second: 2, first: 1 }),
    });
    assert.equal(r2.status, 201);
    assert.equal(r2.headers.get('idempotency-replayed'), 'true');
    const body2 = (await r2.json()) as any;
    assert.equal(body2.execution, 1, 'Replayed request must not execute handler twice');

    // 3. Same key with DIFFERENT payload -> 422
    const conflictRes = await fetch(`${baseUrl}/items`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idem-key-001',
        'x-test-user': 'user_a',
      },
      body: JSON.stringify({ first: 999, second: 2 }),
    });
    assert.equal(conflictRes.status, 422);
    assert.equal(((await conflictRes.json()) as any).error, 'IDEMPOTENCY_KEY_CONFLICT');

    // 4. Different principal reusing the same key executes independently (strict isolation)
    const userBRes = await fetch(`${baseUrl}/items`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idem-key-001',
        'x-test-user': 'user_b',
      },
      body: JSON.stringify({ first: 1, second: 2 }),
    });
    assert.equal(userBRes.status, 201);
    assert.equal(userBRes.headers.get('idempotency-replayed'), null);
    assert.equal(((await userBRes.json()) as any).execution, 2);

    // 5. Transient 500 error is NOT cached, so retry succeeds cleanly
    shouldFailServer = true;
    const errRes = await fetch(`${baseUrl}/items`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idem-key-retry',
        'x-test-user': 'user_a',
      },
      body: JSON.stringify({ retry: true }),
    });
    assert.equal(errRes.status, 500);

    shouldFailServer = false;
    const retryRes = await fetch(`${baseUrl}/items`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idem-key-retry',
        'x-test-user': 'user_a',
      },
      body: JSON.stringify({ retry: true }),
    });
    assert.equal(retryRes.status, 201);
    assert.equal(retryRes.headers.get('idempotency-replayed'), null);

    // 6. Concurrent in-flight request with identical key -> 409 Conflict
    const slowPromise = fetch(`${baseUrl}/slow`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idem-key-inflight',
        'x-test-user': 'user_a',
      },
      body: JSON.stringify({ slow: true }),
    });
    // Wait briefly until handler is in-flight
    while (!releaseSlowRequest) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const dupRes = await fetch(`${baseUrl}/slow`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idem-key-inflight',
        'x-test-user': 'user_a',
      },
      body: JSON.stringify({ slow: true }),
    });
    assert.equal(dupRes.status, 409);
    assert.equal(((await dupRes.json()) as any).error, 'IDEMPOTENCY_REQUEST_IN_PROGRESS');
    assert.equal(dupRes.headers.get('retry-after'), '2');

    releaseSlowRequest!();
    const slowFinal = await slowPromise;
    assert.equal(slowFinal.status, 200);
  });
});

test('API Router - end-to-end idempotency on PATCH /reels/:id/status, POST /auth/otp/verify, and rate limit on POST /auth/otp/request', async () => {
  clearIdempotencyStoreForTesting();
  clearOtpsForTesting();
  clearOtpRateLimitsForTesting();
  resetApiRateLimitersForTesting();
  Repository.resetMemoryStoreForTests();

  const creator = await Repository.upsertCreator({
    instagram_user_id: 'creator_idem_test',
    username: 'creator_idem_test',
  });
  const now = new Date().toISOString();
  const reel = await Repository.upsertSavedReel({
    instagram_media_id: 'media_idem_01',
    creator_id: creator.id,
    shortcode: 'IdemShort01',
    reel_url: 'https://www.instagram.com/reel/IdemShort01/',
    instagram_sender_id: 'sender_idem_user',
    is_saved_on_instagram: false,
    taken_at: now,
    first_detected_at: now,
    save_order_rank: 1,
  });

  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);

  await withServer(app, async (baseUrl) => {
    const userKey = generateUserVaultKey('sender_idem_user');

    // 1. PATCH /api/reels/:id/status with Idempotency-Key replays cleanly
    const patch1 = await fetch(`${baseUrl}/api/reels/${encodeURIComponent(reel.id)}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-Vault-Key': userKey,
        'Idempotency-Key': 'status-idem-1',
      },
      body: JSON.stringify({ status: 'watched' }),
    });
    assert.equal(patch1.status, 200);
    assert.equal(((await patch1.json()) as any).watch_status, 'watched');

    const patch2 = await fetch(`${baseUrl}/api/reels/${encodeURIComponent(reel.id)}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-Vault-Key': userKey,
        'Idempotency-Key': 'status-idem-1',
      },
      body: JSON.stringify({ status: 'watched' }),
    });
    assert.equal(patch2.status, 200);
    assert.equal(patch2.headers.get('idempotency-replayed'), 'true');

    // 2. Retrying POST /api/auth/otp/verify with the SAME Idempotency-Key replays the vaultKey safely
    // (handles dropped network response after single-use OTP consumption)
    const otpCode = createOtp({ role: 'user', senderId: 'sender_idem_user' });
    const otp1 = await fetch(`${baseUrl}/api/auth/otp/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'otp-idem-1',
      },
      body: JSON.stringify({ code: otpCode }),
    });
    assert.equal(otp1.status, 200);
    const otpBody1 = (await otp1.json()) as any;
    assert.equal(otpBody1.vaultKey, userKey);

    const otpRetrySameKey = await fetch(`${baseUrl}/api/auth/otp/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'otp-idem-1',
      },
      body: JSON.stringify({ code: otpCode }),
    });
    assert.equal(otpRetrySameKey.status, 200);
    assert.equal(otpRetrySameKey.headers.get('idempotency-replayed'), 'true');
    assert.equal(otpRetrySameKey.headers.get('cache-control'), 'no-store', 'Replayed OTP response must preserve Cache-Control: no-store');
    assert.equal(((await otpRetrySameKey.json()) as any).vaultKey, userKey);

    // Reusing the consumed OTP WITHOUT the same Idempotency-Key is still rejected as single-use!
    const otpReuseNoKey = await fetch(`${baseUrl}/api/auth/otp/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: otpCode }),
    });
    assert.equal(otpReuseNoKey.status, 400);
    assert.equal(((await otpReuseNoKey.json()) as any).error, 'INVALID_OR_EXPIRED_CODE');

    // 3. POST /api/auth/otp/request is rate-limited after 5 calls per IP
    for (let i = 0; i < 5; i++) {
      const reqRes = await fetch(`${baseUrl}/api/auth/otp/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'unknown_user' }),
      });
      assert.equal(reqRes.status, 200);
    }
    const throttled = await fetch(`${baseUrl}/api/auth/otp/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'unknown_user' }),
    });
    assert.equal(throttled.status, 429);
    assert.equal(((await throttled.json()) as any).error, 'TOO_MANY_OTP_REQUESTS');
  });
});

test('MetaInstagramBotService - deduplicates repeated webhook deliveries by message ID (mid)', async () => {
  const bot = new MetaInstagramBotService();
  let dmCalls = 0;
  bot.sendDirectMessage = async () => {
    dmCalls++;
    return true;
  };

  const webhookBody = {
    object: 'instagram',
    entry: [
      {
        messaging: [
          {
            sender: { id: 'sender_dedup_test' },
            message: { mid: 'mid.duplicate_12345', text: 'help' },
          },
        ],
        changes: [
          {
            field: 'messages',
            value: {
              sender: { id: 'sender_dedup_test' },
              message: { mid: 'mid.duplicate_12345', text: 'help' },
            },
          },
        ],
      },
    ],
  };

  // Dispatch identical payload twice (and with both messaging + changes containing same mid)
  await bot.handleWebhookPayload(webhookBody);
  await bot.handleWebhookPayload(webhookBody);

  assert.equal(dmCalls, 1, 'Identical webhook mid across messaging/changes and retries must execute only once');
});

test('Security - Supabase migration 015 locks down over-permissive RLS policies on creators and saved_reels', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const sql = fs.readFileSync(
    path.join(process.cwd(), 'supabase/migrations/015_lock_down_rls_policies.sql'),
    'utf8'
  );

  assert.ok(sql.includes('DROP POLICY IF EXISTS "Allow public read on creators" ON public.creators;'));
  assert.ok(sql.includes('DROP POLICY IF EXISTS "Allow service_role all on creators" ON public.creators;'));
  assert.ok(sql.includes('DROP POLICY IF EXISTS "Allow public read on saved_reels" ON public.saved_reels;'));
  assert.ok(sql.includes('DROP POLICY IF EXISTS "Allow service_role all on saved_reels" ON public.saved_reels;'));
  assert.ok(sql.includes('REVOKE ALL ON public.creators FROM anon, authenticated;'));
  assert.ok(sql.includes('REVOKE ALL ON public.saved_reels FROM anon, authenticated;'));
  assert.ok(sql.includes('REVOKE ALL ON FUNCTION public.search_saved_reels(TEXT) FROM PUBLIC, anon, authenticated;'));

  const { loadConfig } = await import('../src/config.ts');
  const origUrl = process.env.SUPABASE_URL;
  const origServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const origAnonKey = process.env.SUPABASE_ANON_KEY;
  try {
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.SUPABASE_ANON_KEY = 'anon-only-key';
    const anonOnlyCfg = loadConfig();
    assert.equal(anonOnlyCfg.supabase.isConfigured, false, 'loadConfig must not accept SUPABASE_ANON_KEY alone');
    assert.equal(anonOnlyCfg.supabase.key, undefined);

    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-secret';
    const serviceCfg = loadConfig();
    assert.equal(serviceCfg.supabase.isConfigured, true);
    assert.equal(serviceCfg.supabase.key, 'service-role-secret');
  } finally {
    if (origUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = origUrl;
    if (origServiceKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = origServiceKey;
    if (origAnonKey === undefined) delete process.env.SUPABASE_ANON_KEY;
    else process.env.SUPABASE_ANON_KEY = origAnonKey;
  }
});

test('Security - ArchiveImportService rejects oversized item arrays (> 50,000 items) with too_large status before DB processing', async () => {
  const { ArchiveImportService } = await import('../src/services/archiveImportService.ts');
  const hugePayload = Array.from({ length: 50_001 }, () => ({}));
  const result = await ArchiveImportService.importArchive(hugePayload);
  assert.equal(result.status, 'too_large');
  assert.equal(result.reelsImported, 0);
  assert.match(result.errors[0] || '', /50,000/);
});

test('Security - Meta oEmbed metadata lookup passes token in Authorization Bearer header, never URL query string', async () => {
  const { fetchReelMetadata, resetFeedMetaResolverStateForTests } = await import(
    '../src/services/reelMetadataResolver.ts'
  );
  const origFetch = globalThis.fetch;
  const origToken = process.env.META_PAGE_ACCESS_TOKEN;
  const origProxy = process.env.METADATA_PROXY_URL;
  resetFeedMetaResolverStateForTests();
  process.env.META_PAGE_ACCESS_TOKEN = 'secret_bearer_token_xyz';
  delete process.env.METADATA_PROXY_URL;

  let seenUrl = '';
  let seenAuth = '';
  try {
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      if (target.includes('graph.facebook.com/v21.0/instagram_oembed')) {
        seenUrl = target;
        seenAuth = String((init?.headers as Record<string, string> | undefined)?.Authorization || '');
        return new Response(
          JSON.stringify({
            author_name: 'HeaderAuthCreator',
            thumbnail_url: 'https://scontent.cdninstagram.com/v/t.jpg',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('<html><title>Login</title></html>', { status: 200 });
    }) as typeof fetch;

    const meta = await fetchReelMetadata('DBearerAuth1', undefined, 'reel');
    assert.equal(meta.username, 'headerauthcreator');
    assert.equal(seenAuth, 'Bearer secret_bearer_token_xyz');
    assert.ok(!seenUrl.includes('access_token='), 'Meta access token must never be placed in URL query string');
  } finally {
    globalThis.fetch = origFetch;
    if (origToken === undefined) delete process.env.META_PAGE_ACCESS_TOKEN;
    else process.env.META_PAGE_ACCESS_TOKEN = origToken;
    if (origProxy === undefined) delete process.env.METADATA_PROXY_URL;
    else process.env.METADATA_PROXY_URL = origProxy;
    resetFeedMetaResolverStateForTests();
  }
});

test('Idempotency - keeps active entries locked on client disconnect and rejects overflow with 503 instead of evicting active locks', async () => {
  const managed = createIdempotencyMiddleware({ maxActiveEntries: 1, maxCompletedEntries: 2 });
  let executions = 0;
  let releaseHandler: (() => void) | null = null;

  const app = express();
  app.use(express.json());
  app.use(managed.middleware);
  app.post('/mutate', async (req, res) => {
    executions++;
    await new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    res.status(200).json({ ok: true, execution: executions, payload: req.body });
  });

  await withServer(app, async (baseUrl) => {
    // 1. Start a mutation and abort the client socket mid-flight
    const ac = new AbortController();
    const firstReq = fetch(`${baseUrl}/mutate`, {
      method: 'POST',
      signal: ac.signal,
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'active-lock-1' },
      body: JSON.stringify({ step: 1 }),
    }).catch(() => null);

    while (!releaseHandler) {
      await new Promise((r) => setTimeout(r, 5));
    }

    // Disconnect client while handler is still running
    ac.abort();
    await firstReq;
    await new Promise((r) => setTimeout(r, 25));

    // 2. Retry with the SAME key must still receive 409 (lock NOT prematurely dropped on disconnect)
    const dupRes = await fetch(`${baseUrl}/mutate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'active-lock-1' },
      body: JSON.stringify({ step: 1 }),
    });
    assert.equal(dupRes.status, 409);
    assert.equal(executions, 1);

    // 3. New distinct key while maxActiveEntries=1 is full must return 503 instead of evicting active-lock-1
    const overflowRes = await fetch(`${baseUrl}/mutate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'active-lock-2' },
      body: JSON.stringify({ step: 2 }),
    });
    assert.equal(overflowRes.status, 503);
    assert.equal(((await overflowRes.json()) as any).error, 'IDEMPOTENCY_CAPACITY_EXCEEDED');

    // 4. Let the original mutation finish -> retry now replays the cached 200 without re-executing!
    releaseHandler!();
    await new Promise((r) => setTimeout(r, 25));

    const replayRes = await fetch(`${baseUrl}/mutate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'active-lock-1' },
      body: JSON.stringify({ step: 1 }),
    });
    assert.equal(replayRes.status, 200);
    assert.equal(replayRes.headers.get('idempotency-replayed'), 'true');
    assert.equal(((await replayRes.json()) as any).execution, 1);
    assert.equal(executions, 1, 'Mutation must have executed strictly once');
  });
});

test('MetaInstagramBotService - automatically retries post-200 transient failures internally without repeating committed mutations', async () => {
  const bot = new MetaInstagramBotService({ retryDelaysMs: [15] });
  const origGetTz = Repository.getSenderTimezone;
  const origMarkWatched = Repository.markWatchedForInstagramSender;

  try {
    // 1. Transient DB exception before side effects -> internal retry executes cleanly without a second webhook call
    let tzAttempts = 0;
    Repository.getSenderTimezone = (async () => {
      tzAttempts++;
      if (tzAttempts === 1) throw new Error('Transient DB blip');
      return 'UTC';
    }) as typeof Repository.getSenderTimezone;

    let helpDeliveries = 0;
    bot.sendDirectMessage = async () => {
      helpDeliveries++;
      return true;
    };

    const helpPayload = {
      object: 'instagram',
      entry: [
        {
          messaging: [
            {
              sender: { id: 'sender_retry_db' },
              message: { mid: 'mid.retry_db_err', text: 'help' },
            },
          ],
        },
      ],
    };

    await bot.handleWebhookPayload(helpPayload);
    assert.equal(helpDeliveries, 0);
    // Wait for scheduled internal retry (15ms)
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(helpDeliveries, 1, 'Internal retry after transient DB error must succeed without external redelivery');
    await bot.handleWebhookPayload(helpPayload);
    assert.equal(helpDeliveries, 1, 'Subsequent duplicate after completion must be deduplicated');

    // 2. DM delivery returning false AFTER a state mutation -> internal retry redelivers DM WITHOUT repeating mutation!
    Repository.getSenderTimezone = async () => 'UTC';
    let markWatchedCalls = 0;
    Repository.markWatchedForInstagramSender = (async () => {
      markWatchedCalls++;
      return { updatedReels: [], remainingCount: 0 };
    }) as typeof Repository.markWatchedForInstagramSender;

    let dmAttempts = 0;
    bot.sendDirectMessage = async () => {
      dmAttempts++;
      return dmAttempts >= 2; // 1st delivery fails, internal retry succeeds
    };

    const watchedPayload = {
      object: 'instagram',
      entry: [
        {
          messaging: [
            {
              sender: { id: 'sender_retry_dm' },
              message: { mid: 'mid.retry_dm_fail', text: 'watched' },
            },
          ],
        },
      ],
    };

    await bot.handleWebhookPayload(watchedPayload);
    assert.equal(markWatchedCalls, 1);
    assert.equal(dmAttempts, 1);

    // Wait for scheduled internal retry (15ms) -> must NOT call markWatchedForInstagramSender again, only redeliver DM
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(markWatchedCalls, 1, 'Internal retry after reply failure must NOT repeat committed state mutation');
    assert.equal(dmAttempts, 2, 'Internal retry must redeliver the failed confirmation DM');

    // Duplicate delivery after completion -> completely deduplicated
    await bot.handleWebhookPayload(watchedPayload);
    assert.equal(markWatchedCalls, 1);
    assert.equal(dmAttempts, 2);

    // 3. Mid-less event still gets an isolated per-event opId so internal retry preserves mutation checkpoint
    let midlessWatchedCalls = 0;
    Repository.markWatchedForInstagramSender = (async () => {
      midlessWatchedCalls++;
      return { updatedReels: [], remainingCount: 0 };
    }) as typeof Repository.markWatchedForInstagramSender;

    let midlessDmAttempts = 0;
    bot.sendDirectMessage = async () => {
      midlessDmAttempts++;
      return midlessDmAttempts >= 2;
    };

    await bot.handleWebhookPayload({
      object: 'instagram',
      entry: [{ messaging: [{ sender: { id: 'sender_midless' }, message: { text: 'watched' } }] }],
    });
    assert.equal(midlessWatchedCalls, 1);
    assert.equal(midlessDmAttempts, 1);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(midlessWatchedCalls, 1, 'Mid-less internal retry must NOT repeat committed mutation');
    assert.equal(midlessDmAttempts, 2, 'Mid-less internal retry must redeliver failed DM');

    // 4. Duration command internal retry stays pinned to the ORIGINAL Reel even if a newer Reel arrives
    const origGetAwaiting = Repository.getActiveAwaitingReelForSender;
    const origGetLast = Repository.getLastReelForInstagramSender;
    const origUpdateSchedule = Repository.updateReminderSchedule;
    try {
      let currentLatestReelId = 'reel_original_1';
      Repository.getActiveAwaitingReelForSender = (async () => ({
        id: currentLatestReelId,
        shortcode: 'OrigReel1',
        reel_url: 'https://www.instagram.com/reel/OrigReel1/',
        media_type: 'reel',
      })) as any;
      Repository.getLastReelForInstagramSender = async () => null;

      const updatedTargets: string[] = [];
      let scheduleAttempts = 0;
      Repository.updateReminderSchedule = (async (reelId: string) => {
        scheduleAttempts++;
        updatedTargets.push(reelId);
        if (scheduleAttempts === 1) {
          // Simulate a brand-new Reel arriving before internal retry runs
          currentLatestReelId = 'reel_newer_2';
          throw new Error('Transient DB write timeout');
        }
      }) as typeof Repository.updateReminderSchedule;
      bot.sendDirectMessage = async () => true;

      await bot.handleWebhookPayload({
        object: 'instagram',
        entry: [
          {
            messaging: [
              { sender: { id: 'sender_duration_pin' }, message: { mid: 'mid.duration_pin', text: '30m' } },
            ],
          },
        ],
      });
      await new Promise((r) => setTimeout(r, 60));
      assert.deepEqual(
        updatedTargets,
        ['reel_original_1', 'reel_original_1'],
        'Duration retry must stay pinned to original Reel instead of retargeting newer Reel'
      );
    } finally {
      Repository.getActiveAwaitingReelForSender = origGetAwaiting;
      Repository.getLastReelForInstagramSender = origGetLast;
      Repository.updateReminderSchedule = origUpdateSchedule;
    }
  } finally {
    bot.clearPendingRetriesForTesting();
    Repository.getSenderTimezone = origGetTz;
    Repository.markWatchedForInstagramSender = origMarkWatched;
  }
});
