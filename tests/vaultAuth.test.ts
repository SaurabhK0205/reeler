import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateUserVaultKey,
  verifyVaultKey,
  getAdminVaultKey,
  vaultAuthMiddleware,
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
