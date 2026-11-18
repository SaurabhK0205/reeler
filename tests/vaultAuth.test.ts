import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateUserVaultKey,
  verifyVaultKey,
  getAdminVaultKey,
  vaultAuthMiddleware,
  createOtp,
  verifyOtp,
  clearOtpsForTesting,
  clearOtpRateLimitsForTesting,
  requestOtpForUsername,
} from '../src/services/vaultAuthService.ts';

test('VaultAuthService - generateUserVaultKey produces URL-safe deterministic keys', () => {
  const senderId = 'instagram_sender_998877';
  const key1 = generateUserVaultKey(senderId);
  const key2 = generateUserVaultKey(senderId);

  assert.equal(key1, key2, 'Keys for identical senderId should be identical');
  assert.ok(!key1.includes('+') && !key1.includes('/') && !key1.includes('='), 'Key must be URL-safe (base64url)');

  assert.throws(() => generateUserVaultKey(''), /Cannot generate vault key for empty senderId/);
});

test('VaultAuthService - verifyVaultKey authenticates valid user key and extracts senderId', () => {
  const senderId = 'sender_user_alpha';
  const key = generateUserVaultKey(senderId);

  const result = verifyVaultKey(key);
  assert.equal(result.valid, true);
  assert.equal(result.session?.role, 'user');
  assert.equal(result.session?.senderId, senderId);
});

test('VaultAuthService - verifyVaultKey authenticates admin key', () => {
  const adminKey = getAdminVaultKey();
  const result = verifyVaultKey(adminKey);

  assert.equal(result.valid, true);
  assert.equal(result.session?.role, 'admin');
  assert.equal(result.session?.senderId, undefined);
});

test('VaultAuthService - verifyVaultKey rejects tampered, empty, or forged keys', () => {
  assert.equal(verifyVaultKey('').valid, false);
  assert.equal(verifyVaultKey('not-a-valid-key').valid, false);

  // Tamper with valid key payload
  const validKey = generateUserVaultKey('real_sender');
  const tamperedKey = validKey.slice(0, -4) + 'zzzz';
  assert.equal(verifyVaultKey(tamperedKey).valid, false);

  // Forged admin prefix with invalid signature
  const forgedAdmin = Buffer.from('admin.admin.invalid_fake_signature').toString('base64url');
  assert.equal(verifyVaultKey(forgedAdmin).valid, false);
});

test('VaultAuthService - vaultAuthMiddleware permits public endpoints without keys', () => {
  const publicPaths = ['/health', '/instagram/webhook', '/reels/D123xyz/meta'];

  for (const path of publicPaths) {
    let nextCalled = false;
    const req: any = { path, headers: {}, query: {} };
    const res: any = {
      status: () => {
        throw new Error(`Should not call status on public path: ${path}`);
      },
    };

    vaultAuthMiddleware(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true, `Path ${path} must bypass vault auth gate`);
  }
});

test('VaultAuthService - vaultAuthMiddleware enforces authentication in production and parses valid keys', () => {
  const origEnv = process.env.NODE_ENV;
  const origVaultSecret = process.env.VAULT_SECRET;
  process.env.NODE_ENV = 'production';
  process.env.VAULT_SECRET = 'test-production-vault-secret';

  try {
    // 1. Missing key -> 401
    let statusSent = 0;
    let jsonSent: any = null;
    const reqWithoutKey: any = { path: '/reels', headers: {}, query: {} };
    const resWithoutKey: any = {
      status: (code: number) => {
        statusSent = code;
        return {
          json: (body: any) => {
            jsonSent = body;
          },
        };
      },
    };

    vaultAuthMiddleware(reqWithoutKey, resWithoutKey, () => {
      assert.fail('next() should not be called when key is missing in production');
    });

    assert.equal(statusSent, 401);
    assert.equal(jsonSent?.code, 'VAULT_KEY_REQUIRED');

    // 2. Valid user key in header -> 200 next()
    let nextCalled = false;
    const userKey = generateUserVaultKey('sender_bob');
    const reqWithKey: any = {
      path: '/reels',
      headers: { 'x-vault-key': userKey },
      query: {},
    };

    vaultAuthMiddleware(reqWithKey, {} as any, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(reqWithKey.vaultUser?.role, 'user');
    assert.equal(reqWithKey.vaultUser?.senderId, 'sender_bob');
  } finally {
    if (origEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = origEnv;
    if (origVaultSecret === undefined) delete process.env.VAULT_SECRET;
    else process.env.VAULT_SECRET = origVaultSecret;
  }
});

test('Repository - enforces sender isolation when querying reels', async () => {
  const { Repository } = await import('../src/db/repository.ts');

  const creator = await Repository.upsertCreator({
    instagram_user_id: 'creator_iso_test',
    username: 'creator_iso_test',
  });

  const now = new Date().toISOString();

  // User 1 reel
  await Repository.upsertSavedReel({
    instagram_media_id: 'media_test_111',
    creator_id: creator.id,
    shortcode: 'UserOneReel01',
    reel_url: 'https://www.instagram.com/reel/UserOneReel01/',
    instagram_sender_id: 'user_111',
    is_saved_on_instagram: false,
    taken_at: now,
    first_detected_at: now,
    save_order_rank: 1,
  });

  // User 2 reel
  await Repository.upsertSavedReel({
    instagram_media_id: 'media_test_222',
    creator_id: creator.id,
    shortcode: 'UserTwoReel01',
    reel_url: 'https://www.instagram.com/reel/UserTwoReel01/',
    instagram_sender_id: 'user_222',
    is_saved_on_instagram: false,
    taken_at: now,
    first_detected_at: now,
    save_order_rank: 2,
  });

  // User 1 query: must see ONLY user 1's reel
  const user1Results = await Repository.getReels({ instagramSenderId: 'user_111' });
  const user1Codes = user1Results.reels.map((r) => r.shortcode);
  assert.ok(user1Codes.includes('UserOneReel01'), 'User 1 must see their own reel');
  assert.ok(!user1Codes.includes('UserTwoReel01'), 'User 1 must NEVER see User 2 reel');

  // User 2 query: must see ONLY user 2's reel
  const user2Results = await Repository.getReels({ instagramSenderId: 'user_222' });
  const user2Codes = user2Results.reels.map((r) => r.shortcode);
  assert.ok(user2Codes.includes('UserTwoReel01'), 'User 2 must see their own reel');
  assert.ok(!user2Codes.includes('UserOneReel01'), 'User 2 must NEVER see User 1 reel');

  // Admin query (instagramSenderId === 'admin' or undefined): can see all reels
  const adminResults = await Repository.getReels({ instagramSenderId: 'admin' });
  const adminCodes = adminResults.reels.map((r) => r.shortcode);
  assert.ok(adminCodes.includes('UserOneReel01'), 'Admin can see User 1 reel');
  assert.ok(adminCodes.includes('UserTwoReel01'), 'Admin can see User 2 reel');
});

test('Repository - scopes stats, creators, and watch status to senderId for strict data isolation and deletion', async () => {
  const { Repository } = await import('../src/db/repository.ts');
  Repository.resetMemoryStoreForTests();

  const creatorA = await Repository.upsertCreator({
    instagram_user_id: 'creator_iso_a',
    username: 'creator_iso_a',
  });
  const creatorB = await Repository.upsertCreator({
    instagram_user_id: 'creator_iso_b',
    username: 'creator_iso_b',
  });

  const now = new Date().toISOString();

  const reel1 = await Repository.upsertSavedReel({
    instagram_media_id: 'media_scope_111',
    creator_id: creatorA.id,
    shortcode: 'UserOneScoped01',
    reel_url: 'https://www.instagram.com/reel/UserOneScoped01/',
    instagram_sender_id: 'user_scope_1',
    is_saved_on_instagram: false,
    taken_at: now,
    first_detected_at: now,
    save_order_rank: 1,
  });

  const reel2 = await Repository.upsertSavedReel({
    instagram_media_id: 'media_scope_222',
    creator_id: creatorB.id,
    shortcode: 'UserTwoScoped01',
    reel_url: 'https://www.instagram.com/reel/UserTwoScoped01/',
    instagram_sender_id: 'user_scope_2',
    is_saved_on_instagram: true,
    taken_at: now,
    first_detected_at: now,
    save_order_rank: 2,
  });

  // 1. User 1 stats: should show total 1, 0 savedOnInstagram, 1 botSent, 1 creator (creatorA)
  const user1Stats = await Repository.getStats('user_scope_1');
  assert.equal(user1Stats.totalReels, 1);
  assert.equal(user1Stats.savedOnInstagramCount, 0);
  assert.equal(user1Stats.botSentCount, 1);
  assert.equal(user1Stats.totalCreators, 1);
  assert.equal(user1Stats.topCreators.length, 1);
  assert.equal(user1Stats.topCreators[0].username, 'creator_iso_a');

  // 2. User 1 creators: should return only creatorA
  const user1Creators = await Repository.getCreators('user_scope_1');
  assert.equal(user1Creators.length, 1);
  assert.equal(user1Creators[0].username, 'creator_iso_a');

  // 3. User 1 queryCreators: should return only creatorA
  const user1Queried = await Repository.queryCreators({ instagramSenderId: 'user_scope_1' });
  assert.equal(user1Queried.creators.length, 1);
  assert.equal(user1Queried.creators[0].username, 'creator_iso_a');

  // 4. Admin stats: should see all 2 reels and both creators
  const adminStats = await Repository.getStats('admin');
  assert.equal(adminStats.totalReels, 2);
  assert.equal(adminStats.totalCreators, 2);

  // 5. Watch status update isolation: user 2 cannot update user 1 reel
  const crossUpdate = await Repository.updateWatchStatus(reel1.id, 'watched', 'user_scope_2');
  assert.equal(crossUpdate, null, 'Updating another user reel must return null');

  const validUpdate = await Repository.updateWatchStatus(reel1.id, 'watched', 'user_scope_1');
  assert.ok(validUpdate, 'Updating own reel must succeed');
  assert.equal(validUpdate.watch_status, 'watched');

  // 6. Strict Deletion: deleting user 1 data purges stats and creators to 0
  const deletedCount = await Repository.deleteUserDataForSender('user_scope_1');
  assert.equal(deletedCount, 1);

  const postDeletionStats = await Repository.getStats('user_scope_1');
  assert.equal(postDeletionStats.totalReels, 0);
  assert.equal(postDeletionStats.totalCreators, 0);
  assert.equal(postDeletionStats.savedOnInstagramCount, 0);
  assert.equal(postDeletionStats.botSentCount, 0);
  assert.equal(postDeletionStats.topCreators.length, 0);

  const postDeletionCreators = await Repository.getCreators('user_scope_1');
  assert.equal(postDeletionCreators.length, 0);

  const postDeletionQuery = await Repository.queryCreators({ instagramSenderId: 'user_scope_1' });
  assert.equal(postDeletionQuery.creators.length, 0);
  assert.equal(postDeletionQuery.totalCount, 0);

  // User 2's data remains untouched
  const user2Stats = await Repository.getStats('user_scope_2');
  assert.equal(user2Stats.totalReels, 1);
  assert.equal(user2Stats.savedOnInstagramCount, 1);
});

test('VaultAuthService - OTP generation, verification, and single-use invalidation', () => {
  clearOtpsForTesting();

  const userSession = { role: 'user' as const, senderId: 'user_otp_test_123' };
  const code = createOtp(userSession);

  assert.match(code, /^\d{6}$/, 'OTP must be a 6-digit numeric string');

  // First verification: must succeed and return vault key and session
  const verify1 = verifyOtp(code);
  assert.equal(verify1.valid, true);
  assert.equal(verify1.session?.role, 'user');
  assert.equal(verify1.session?.senderId, 'user_otp_test_123');
  assert.ok(verify1.vaultKey, 'Must return vault key');

  // Verify that the issued vault key is valid
  const keyCheck = verifyVaultKey(verify1.vaultKey!);
  assert.equal(keyCheck.valid, true);
  assert.equal(keyCheck.session?.senderId, 'user_otp_test_123');

  // Second verification of same code: must fail (single-use consumption)
  const verify2 = verifyOtp(code);
  assert.equal(verify2.valid, false, 'OTP must be invalid after first use');
});

test('VaultAuthService - OTP expiration and invalid input rejection', async () => {
  clearOtpsForTesting();

  // Test invalid codes
  assert.equal(verifyOtp('').valid, false);
  assert.equal(verifyOtp('12345').valid, false);
  assert.equal(verifyOtp('abcdef').valid, false);
  assert.equal(verifyOtp('999999').valid, false);

  // Test expiration with 1ms TTL
  const fastCode = createOtp({ role: 'admin' }, 1);
  await new Promise((resolve) => setTimeout(resolve, 10));

  const verifyExpired = verifyOtp(fastCode);
  assert.equal(verifyExpired.valid, false, 'Expired OTP must be rejected');
});

test('VaultAuthService - vaultAuthMiddleware permits /auth/otp endpoints without existing vault key', () => {
  const otpPaths = ['/auth/otp/verify', '/auth/otp/request'];

  for (const path of otpPaths) {
    let nextCalled = false;
    const req: any = { path, headers: {}, query: {} };
    const res: any = {
      status: () => {
        throw new Error(`Should not call status on public path: ${path}`);
      },
    };

    vaultAuthMiddleware(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true, `Path ${path} must bypass vault auth middleware`);
  }
});

test('API Router - /auth/otp/verify verifies code and issues permanent vault key', async () => {
  const { apiRouter } = await import('../src/api/router.ts');
  clearOtpsForTesting();

  const code = createOtp({ role: 'user', senderId: 'user_http_test_99' });

  // 1. Verify with valid OTP code
  let statusSent = 200;
  let jsonSent: any = null;
  const mockReq: any = {
    method: 'POST',
    url: '/auth/otp/verify',
    body: { code },
    headers: {},
  };
  const mockRes: any = {
    status: (code: number) => {
      statusSent = code;
      return mockRes;
    },
    json: (body: any) => {
      jsonSent = body;
    },
  };

  // Find the router stack layer for /auth/otp/verify
  const routeLayer = (apiRouter.stack as any[]).find(
    (layer) => layer.route?.path === '/auth/otp/verify' && layer.route?.methods?.post
  );
  assert.ok(routeLayer, 'Must find POST /auth/otp/verify route in apiRouter');

  await routeLayer.route.stack[0].handle(mockReq, mockRes, async () => {
    await routeLayer.route.stack[1].handle(mockReq, mockRes, () => {});
  });

  assert.equal(statusSent, 200);
  assert.equal(jsonSent?.success, true);
  assert.equal(jsonSent?.role, 'user');
  assert.equal(jsonSent?.senderId, 'user_http_test_99');
  assert.ok(jsonSent?.vaultKey, 'Must receive vaultKey');

  // Verify that the returned key is legitimate
  const verification = verifyVaultKey(jsonSent.vaultKey);
  assert.equal(verification.valid, true);
  assert.equal(verification.session?.senderId, 'user_http_test_99');

  // 2. Immediate re-use of same code: must return 400 INVALID_OR_EXPIRED_CODE
  let reuseStatus = 200;
  let reuseJson: any = null;
  const reuseRes: any = {
    status: (c: number) => {
      reuseStatus = c;
      return reuseRes;
    },
    json: (b: any) => {
      reuseJson = b;
    },
  };

  await routeLayer.route.stack[0].handle(mockReq, reuseRes, async () => {
    await routeLayer.route.stack[1].handle(mockReq, reuseRes, () => {});
  });
  assert.equal(reuseStatus, 400);
  assert.equal(reuseJson?.error, 'INVALID_OR_EXPIRED_CODE');
});

test('VaultAuthService - createOtp resolves collisions and never overwrites active sessions', () => {
  clearOtpsForTesting();

  // Create first session OTP
  const sessionA = { role: 'user' as const, senderId: 'user_session_A' };
  const codeA = createOtp(sessionA);

  // Create second session OTP
  const sessionB = { role: 'admin' as const };
  const codeB = createOtp(sessionB);

  assert.notEqual(codeA, codeB, 'Consecutive OTP codes must be unique');

  // Verify first session is intact and not replaced
  const verifyA = verifyOtp(codeA);
  assert.equal(verifyA.valid, true);
  assert.equal(verifyA.session?.senderId, 'user_session_A');

  // Verify second session is also intact
  const verifyB = verifyOtp(codeB);
  assert.equal(verifyB.valid, true);
  assert.equal(verifyB.session?.role, 'admin');
});

test('API Router - /auth/otp/verify enforces rate limiting after multiple failed attempts', async () => {
  const { apiRouter } = await import('../src/api/router.ts');
  clearOtpsForTesting();
  clearOtpRateLimitsForTesting();

  const ip = '198.51.100.42';
  const mockReq: any = {
    method: 'POST',
    url: '/auth/otp/verify',
    ip,
    body: { code: '000000' },
    headers: {},
  };

  let lastStatus = 200;
  let lastJson: any = null;
  const mockRes: any = {
    status: (code: number) => {
      lastStatus = code;
      return mockRes;
    },
    json: (body: any) => {
      lastJson = body;
    },
    set: () => {},
  };

  const routeLayer = (apiRouter.stack as any[]).find(
    (layer) => layer.route?.path === '/auth/otp/verify' && layer.route?.methods?.post
  );
  assert.ok(routeLayer, 'Must find POST /auth/otp/verify route');

  // Trigger 5 failed attempts
  for (let i = 0; i < 5; i++) {
    await routeLayer.route.stack[0].handle(mockReq, mockRes, async () => {
      await routeLayer.route.stack[1].handle(mockReq, mockRes, () => {});
    });
    assert.equal(lastStatus, 400);
  }

  // 6th attempt: middleware must trigger 429 TOO_MANY_ATTEMPTS
  let rateLimited = false;
  await routeLayer.route.stack[0].handle(mockReq, mockRes, () => {
    rateLimited = false;
  });
  assert.equal(lastStatus, 429);
  assert.equal(lastJson?.error, 'TOO_MANY_ATTEMPTS');
});

test('API Router - /auth/otp/verify rejects non-string payloads with 400', async () => {
  const { apiRouter } = await import('../src/api/router.ts');
  clearOtpRateLimitsForTesting();

  const mockReq: any = {
    method: 'POST',
    url: '/auth/otp/verify',
    body: { code: 123456 }, // number instead of string
    headers: {},
  };

  let statusSent = 200;
  let jsonSent: any = null;
  const mockRes: any = {
    status: (code: number) => {
      statusSent = code;
      return mockRes;
    },
    json: (body: any) => {
      jsonSent = body;
    },
  };

  const routeLayer = (apiRouter.stack as any[]).find(
    (layer) => layer.route?.path === '/auth/otp/verify' && layer.route?.methods?.post
  );

  await routeLayer.route.stack[0].handle(mockReq, mockRes, async () => {
    await routeLayer.route.stack[1].handle(mockReq, mockRes, () => {});
  });

  assert.equal(statusSent, 400);
  assert.equal(jsonSent?.error, 'INVALID_REQUEST');
});

test('VaultAuthService - requestOtpForUsername checks delivery and returns structured outcome', async () => {
  const origAdmin = process.env.ADMIN_USERNAME;
  process.env.ADMIN_USERNAME = 'sybaurabh';

  try {
    // 1. Delivery failure
    const failResult = await requestOtpForUsername(
      'sybaurabh',
      async () => false, // DM delivery returns false
      'admin_sender_test'
    );
    assert.equal(failResult.success, false);
    assert.equal(failResult.code, 'DELIVERY_FAILED');

    // 2. Successful delivery
    let deliveredMsg = '';
    const successResult = await requestOtpForUsername(
      'sybaurabh',
      async (_id, msg) => {
        deliveredMsg = msg;
        return true;
      },
      'admin_sender_test'
    );
    assert.equal(successResult.success, true);
    assert.ok(deliveredMsg.includes('Your Reeler Login Code:'));

    // 3. Unknown / unmapped user
    const unknownResult = await requestOtpForUsername(
      'random_stranger',
      async () => true,
      null
    );
    assert.equal(unknownResult.success, false);
    assert.equal(unknownResult.code, 'DM_THE_BOT_DIRECTLY');
  } finally {
    process.env.ADMIN_USERNAME = origAdmin;
  }
});

test('Vault UI exposes reversible Switch Vault, explicit Sign Out, and Idempotency-Key wiring', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const root = path.resolve(process.cwd());

  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8');

  assert.ok(html.includes('id="switch-vault-btn"'), 'Header must include Switch Vault button');
  assert.ok(html.includes('id="vault-gate-cancel-btn"'), 'Vault gate must include Back to Current Vault cancel button');
  assert.ok(html.includes('id="vault-gate-signout-btn"'), 'Vault gate must include explicit Sign out button');

  const switchFnMatch = js.match(/function handleSwitchVault\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(switchFnMatch, 'app.js must define handleSwitchVault');
  assert.ok(!switchFnMatch[0].includes('setVaultAccessKey(null)'), 'handleSwitchVault must NOT wipe active vault key before switching succeeds');
  assert.ok(switchFnMatch[0].includes('preserveWorkspace: true'), 'handleSwitchVault must preserve active workspace so user can cancel cleanly');

  const cancelFnMatch = js.match(/function cancelSwitchVault\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(cancelFnMatch, 'app.js must define cancelSwitchVault');
  assert.ok(cancelFnMatch[0].includes('hideVaultGateScreen()'), 'cancelSwitchVault must return directly to the active vault');
  assert.ok(cancelFnMatch[0].includes('invalidatePendingVaultAuth()'), 'cancelSwitchVault must invalidate any pending auth request');

  assert.ok(js.includes('if (!isSwitchingVault) {\n      hideVaultGateScreen();'), 'Background fetchReels must not close an active Switch Vault gate');
  assert.ok(js.includes('getOtpAttemptIdempotencyKey(entered)'), 'OTP verification must reuse the attempt Idempotency-Key across network retries');
  assert.ok(js.includes('await Promise.all([loadStats(), loadCreators(), fetchReels()]);'), 'Authenticated vault commit must kick off all catalog loads together independent of later switch attempts');

  const resetFnMatch = js.match(/function resetVaultSessionState\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(resetFnMatch, 'app.js must define resetVaultSessionState');
  const resetBody = resetFnMatch[0];
  assert.ok(resetBody.includes('fetchReelsAbortController.abort()'), 'resetVaultSessionState must cancel in-flight reels fetches');
  assert.ok(resetBody.includes('creatorsFetchController.abort()'), 'resetVaultSessionState must cancel in-flight creator fetches');
  assert.ok(resetBody.includes('statsFetchController.abort()'), 'resetVaultSessionState must cancel in-flight stats fetches');
  assert.ok(resetBody.includes('state.creators = []'), 'resetVaultSessionState must clear previous vault creators');
  assert.ok(resetBody.includes('state.topCreators = []'), 'resetVaultSessionState must clear previous vault topCreators');
  assert.ok(resetBody.includes('state.selectedCreator = null'), 'resetVaultSessionState must clear selectedCreator');
  assert.ok(resetBody.includes("state.filters.creatorId = ''"), 'resetVaultSessionState must clear creator filter');
  assert.ok(resetBody.includes('state.filters.page = 1'), 'resetVaultSessionState must reset pagination to page 1');
  assert.ok(resetBody.includes('syncUrlState()'), 'resetVaultSessionState must sync reset filters to URL');
  assert.ok(resetBody.includes("reelsGrid.innerHTML = ''"), 'resetVaultSessionState must clear previous catalog grid DOM on commit/sign-out');
  assert.ok(resetBody.includes("reelsTableBody.innerHTML = ''"), 'resetVaultSessionState must clear previous catalog table DOM on commit/sign-out');

  const signOutFnMatch = js.match(/function confirmSignOutVault\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(signOutFnMatch, 'app.js must define confirmSignOutVault');
  assert.ok(signOutFnMatch[0].includes('setVaultAccessKey(null)'), 'confirmSignOutVault must clear stored vault key');
  assert.ok(signOutFnMatch[0].includes('resetVaultSessionState()'), 'confirmSignOutVault must reset vault session state');

  assert.ok(js.includes("'Idempotency-Key'"), 'app.js must send Idempotency-Key headers on mutating requests');
  assert.ok(js.includes('syncSwitchVaultButtonVisibility()'), 'app.js must sync Switch Vault visibility with auth state');
  assert.ok(css.includes('.nav-btn:active:not(:disabled)'), 'style.css must provide tactile :active feedback for nav buttons');
  assert.ok(css.includes('.nav-btn:active'), 'style.css must respect prefers-reduced-motion for nav buttons');
});

test('Frontend CSS tokens, locked workspace isolation, and optical craft invariants hold', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const root = path.resolve(process.cwd());

  const css = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');

  // 1. Every var(--token) referenced in style.css must be defined in style.css (prevents silent fallback breakage)
  const definedTokens = new Set([...css.matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)].map((m) => m[1]));
  const referencedTokens = [...css.matchAll(/var\((--[a-zA-Z0-9_-]+)/g)].map((m) => m[1]);
  const undefinedTokens = [...new Set(referencedTokens.filter((token) => !definedTokens.has(token)))];
  assert.deepEqual(undefinedTokens, [], `Found undefined CSS custom properties in public/style.css: ${undefinedTokens.join(', ')}`);

  // 2. Locked workspace isolation: showVaultGateScreen / hideVaultGateScreen must toggle .is-vault-locked
  assert.ok(js.includes("vaultContainerEl.classList.add('is-vault-locked')"), 'showVaultGateScreen must lock workspace container');
  assert.ok(js.includes("vaultContainerEl.classList.remove('is-vault-locked')"), 'hideVaultGateScreen must unlock workspace container');
  assert.ok(css.includes('.vault-container.is-vault-locked .stats-bar'), 'style.css must hide stats-bar while vault is locked');

  // 3. Performance & craft invariants (Emil Kowalski + Benji Taylor)
  assert.ok(css.includes('contain: layout paint;'), 'Poster cards must apply layout/paint containment');
  assert.ok(css.includes('transform: translateX(1px);'), 'Play triangle icons must be optically centered');
  assert.ok(css.includes('.metric-filter-btn:active'), 'Stat filter cards must include tactile :active feedback and reduced-motion override');

  // Cascade-aware reduced-motion check: the @media (prefers-reduced-motion: reduce) rule disabling
  // .vault-gate-card animation and .vault-tab-btn transforms/transitions must appear AFTER the base
  // declarations so equal-specificity rules cannot override reduced motion.
  const gateAnimMatches = [...css.matchAll(/\.vault-gate-card\s*\{[^}]*animation\s*:\s*vaultGateEnter[^}]*\}/g)];
  assert.equal(gateAnimMatches.length, 1, 'Expected exactly one base .vault-gate-card animation declaration');
  const lastGateAnimEnd = (gateAnimMatches[0].index ?? 0) + gateAnimMatches[0][0].length;

  const tabBaseMatches = [...css.matchAll(/\.vault-tab-btn\s*\{[^}]*transition\s*:[^}]*\}/g)];
  assert.ok(tabBaseMatches.length >= 1, 'Expected base .vault-tab-btn transition declaration');
  const lastTabBaseEnd = Math.max(...tabBaseMatches.map((m) => (m.index ?? 0) + m[0].length));

  const reducedMotionIndex = css.lastIndexOf('@media (prefers-reduced-motion: reduce)');
  assert.ok(reducedMotionIndex > lastGateAnimEnd, '@media (prefers-reduced-motion: reduce) must appear after .vault-gate-card animation declaration');
  assert.ok(reducedMotionIndex > lastTabBaseEnd, '@media (prefers-reduced-motion: reduce) must appear after .vault-tab-btn transition declaration');

  const reducedMotionBlock = css.slice(reducedMotionIndex);
  assert.match(
    reducedMotionBlock,
    /\.vault-gate-card\s*\{[^}]*animation\s*:\s*none\s*;/,
    'Reduced-motion block must disable .vault-gate-card animation after its base rule'
  );
  assert.match(
    reducedMotionBlock,
    /\.vault-tab-btn[\s\S]*?transition-property\s*:\s*opacity,\s*background-color,\s*border-color,\s*color\s*;/,
    'Reduced-motion block must override .vault-tab-btn transition-property after its base rule'
  );

  // 4. HTML cache-busting query versions stay aligned
  assert.ok(html.includes('style.css?v=4.8'), 'index.html must reference style.css?v=4.8');
  assert.ok(html.includes('app.js?v=4.8'), 'index.html must reference app.js?v=4.8');

  // 5. Emil Kowalski + Benji Taylor motion craft invariants hold
  assert.ok(css.includes('--ease-out: cubic-bezier(0.23, 1, 0.32, 1);'), 'style.css must define custom --ease-out token');
  const easeInTransitionRe = /transition\s*:[^;}]*(?:^|[\s,])ease-in(?=$|[\s,;}])/;
  assert.doesNotMatch(
    css,
    easeInTransitionRe,
    'style.css must not use sluggish ease-in on UI transitions (ease-in-out remains permitted)'
  );
  assert.match('.test { transition: opacity 120ms ease-in}', easeInTransitionRe);
  assert.doesNotMatch('.test { transition: opacity 120ms ease-in-out}', easeInTransitionRe);

  /**
   * Extracts effective CSS transition property names across all rules targeting a given selector,
   * expanding omitted shorthand properties to their CSS default `all`.
   */
  const extractEffectiveTransitionProperties = (stylesheet: string, targetSelector: string): string[] => {
    const props: string[] = [];
    const cleaned = stylesheet.replace(/\/\*[\s\S]*?\*\//g, '');
    const ruleRe = /([^{}@]+)\{([^{}]+)\}/g;
    let match: RegExpExecArray | null;
    while ((match = ruleRe.exec(cleaned)) !== null) {
      const selectors = match[1].split(',').map((s) => s.trim());
      const selectorPattern = new RegExp(
        `(?:^|[\\s>+~])${targetSelector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[\\s>+~.:#\\[])`
      );
      if (!selectors.some((sel) => selectorPattern.test(sel))) continue;
      const decls = match[2].split(';');
      for (const decl of decls) {
        const colonIdx = decl.indexOf(':');
        if (colonIdx === -1) continue;
        const propName = decl.slice(0, colonIdx).trim().toLowerCase();
        const rawValue = decl.slice(colonIdx + 1).replace(/!important\b/gi, '').trim();
        if (!rawValue) continue;
        if (propName === 'transition-property') {
          for (const item of rawValue.split(',')) {
            const token = item.trim().toLowerCase();
            if (token) props.push(token);
          }
        } else if (propName === 'transition') {
          const items: string[] = [];
          let depth = 0;
          let buf = '';
          for (const ch of rawValue) {
            if (ch === '(') depth++;
            else if (ch === ')') depth = Math.max(0, depth - 1);
            if (ch === ',' && depth === 0) {
              items.push(buf.trim());
              buf = '';
            } else {
              buf += ch;
            }
          }
          if (buf.trim()) items.push(buf.trim());
          for (const item of items) {
            const stripped = item
              .replace(/[a-z-]+\([^)]*\)/gi, ' ')
              .replace(/\b\d*\.?\d+(?:m?s)\b/gi, ' ')
              .trim();
            const tokens = stripped
              .split(/\s+/)
              .map((t) => t.toLowerCase())
              .filter(
                (t) =>
                  t &&
                  ![
                    'ease',
                    'ease-in',
                    'ease-out',
                    'ease-in-out',
                    'linear',
                    'step-start',
                    'step-end',
                    'normal',
                    'allow-discrete',
                  ].includes(t)
              );
            props.push(tokens[0] || 'all');
          }
        }
      }
    }
    return props;
  };

  const forbiddenViewportProps = new Set(['width', 'height', 'all']);
  const viewportTransitionProps = extractEffectiveTransitionProperties(css, '.reel-media-viewport');
  assert.ok(
    viewportTransitionProps.every((p) => !forbiddenViewportProps.has(p)),
    `.reel-media-viewport must not animate width/height/all (found: ${viewportTransitionProps.join(', ')})`
  );
  assert.deepEqual(
    extractEffectiveTransitionProperties('.reel-media-viewport { transition: 120ms linear; }', '.reel-media-viewport'),
    ['all'],
    'Shorthand transition without explicit property must resolve to implicit all'
  );
  assert.deepEqual(
    extractEffectiveTransitionProperties(
      '.reel-media-viewport { transition: opacity 0.12s linear; }',
      '.reel-media-viewport'
    ),
    ['opacity'],
    'Opacity-only transition on .reel-media-viewport must remain permitted'
  );
  assert.match(
    css,
    /\.shortcuts-popover\s*\{[^}]*transform-origin\s*:\s*top right\s*;/,
    '.shortcuts-popover must scale from top right trigger origin'
  );
  assert.match(
    reducedMotionBlock,
    /\.shortcuts-popover[\s\S]*?animation\s*:\s*none\s*;/,
    'Reduced-motion block must disable .shortcuts-popover animation'
  );

  // 6. Lazy grid thumbnail hydration is wired cleanly in app.js
  assert.ok(js.includes('function observeGridCardsForThumbnails()'), 'app.js must wire lazy viewport grid thumbnail hydration');
  assert.ok(js.includes('function resetGridThumbnailHydration()'), 'app.js must cancel stale grid thumbnail lookups on navigation/reset');
  assert.ok(js.includes('MAX_GRID_THUMB_CONCURRENCY'), 'app.js must bound concurrent grid thumbnail lookups');
});
