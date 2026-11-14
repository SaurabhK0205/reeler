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
  process.env.NODE_ENV = 'production';

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
    process.env.NODE_ENV = origEnv;
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
