import assert from 'node:assert/strict';

// Pin test execution strictly to the in-memory store
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.SUPABASE_ANON_KEY;

const { ArchiveImportService, normalizeMetaExportText } = await import('../src/services/archiveImportService.ts');
const { Repository } = await import('../src/db/repository.ts');

async function runTests() {
  console.log('--- Running ArchiveImportService Regression Tests ---');

  // Test 1: Real Instagram saved_posts.json shape with creator handle in item.title
  console.log('Test 1: Official Instagram saved_posts.json with title-as-username');
  const officialExportPayload = {
    saved_saved_media: [
      {
        title: 'natgeo',
        string_map_data: {
          'Saved on': {
            href: 'https://www.instagram.com/reel/C123ABCxyz/',
            timestamp: 1700000000,
          },
        },
      },
    ],
  };

  const res1 = await ArchiveImportService.importArchive(officialExportPayload);
  assert.equal(res1.status, 'success');
  assert.equal(res1.reelsImported, 1);
  assert.equal(res1.creatorsAdded, 1);

  const { reels: list1 } = await Repository.getReels({ limit: 10 });
  const reel1 = list1.find((r) => r.shortcode === 'C123ABCxyz');
  assert.ok(reel1, 'Reel C123ABCxyz should exist');
  assert.equal(reel1.creator?.username, 'natgeo', 'Creator username must be parsed from item.title');
  assert.equal(reel1.caption, null, 'item.title must NEVER be stored as caption');

  // Test 2: Item with non-handle title (e.g. sentence/phrasing)
  console.log('Test 2: Non-handle title should not be treated as creator');
  const nonHandleTitlePayload = {
    saved_saved_media: [
      {
        title: 'A long sentence that is definitely not an IG handle!',
        string_map_data: {
          'Saved on': {
            href: 'https://www.instagram.com/reel/C456GHIjkl/',
            timestamp: 1700000000,
          },
        },
      },
    ],
  };

  const res2 = await ArchiveImportService.importArchive(nonHandleTitlePayload);
  assert.equal(res2.status, 'success');
  assert.equal(res2.reelsImported, 1);

  const { reels: list2 } = await Repository.getReels({ limit: 10 });
  const reel2 = list2.find((r) => r.shortcode === 'C456GHIjkl');
  assert.ok(reel2, 'Reel C456GHIjkl should exist');
  assert.equal(reel2.creator?.username, 'unattributed', 'Non-handle title should fallback to unattributed');
  assert.equal(reel2.caption, null, 'Title must not be stored as caption');

  // Test 3: Idempotent duplicate import (with ignoreDuplicates & skipReturn)
  console.log('Test 3: Idempotent re-import of existing reel');
  const res3 = await ArchiveImportService.importArchive(officialExportPayload);
  assert.equal(res3.status, 'success');
  assert.equal(res3.reelsImported, 0, 'Re-imported reel should not count as newly imported');
  assert.equal(res3.alreadyPresent, 1, 'Re-imported reel should be counted as already present');

  // Test 4: Completely empty export payload returns 'empty' status with actionable error
  console.log('Test 4: Empty export payload');
  const emptyPayload = { saved_saved_media: [] };
  const res4 = await ArchiveImportService.importArchive(emptyPayload);
  assert.equal(res4.status, 'empty');
  assert.equal(res4.reelsImported, 0);
  assert.ok(res4.errors.length > 0, 'Errors must contain actionable message when empty');
  assert.match(res4.errors[0], /No saved media items found/);

  // Test 5: Non-reel links only (all items skipped) returns 'empty' with actionable error
  console.log('Test 5: Export with only non-reel URLs');
  const nonReelPayload = {
    saved_saved_media: [
      {
        title: 'someone',
        string_map_data: {
          'Saved on': {
            href: 'https://www.instagram.com/stories/highlights/12345/',
            timestamp: 1700000000,
          },
        },
      },
    ],
  };
  const res5 = await ArchiveImportService.importArchive(nonReelPayload);
  assert.equal(res5.status, 'empty');
  assert.equal(res5.reelsImported, 0);
  assert.ok(res5.errors.length > 0, 'Errors must contain actionable message when all items skipped');
  assert.match(res5.errors[0], /No valid Instagram reel links found/);

  // Test 6: Modern Meta Account Center export format (label_values with Owner dict)
  console.log('Test 6: Modern Meta Account Center format (label_values)');
  const modernExportPayload = [
    {
      timestamp: 1794138985,
      fbid: '18084562202346176',
      label_values: [
        {
          label: 'URL',
          value: 'https://www.instagram.com/reel/Dcdva79zKqT/',
          href: 'https://www.instagram.com/reel/Dcdva79zKqT/',
        },
        {
          label: 'Caption',
          value: 'Ajeeb.',
        },
        {
          title: 'Owner',
          dict: [
            {
              dict: [
                { label: 'Username', value: 'bhaavyaa____' },
                { label: 'Name', value: 'Bhaavya Tiwari' },
              ],
            },
          ],
        },
      ],
    },
  ];

  const res6 = await ArchiveImportService.importArchive(modernExportPayload);
  assert.equal(res6.status, 'success');
  assert.equal(res6.reelsImported, 1);
  assert.equal(res6.creatorsAdded, 1);

  const { reels: list6 } = await Repository.getReels({ limit: 10 });
  const reel6 = list6.find((r) => r.shortcode === 'Dcdva79zKqT');
  assert.ok(reel6, 'Reel Dcdva79zKqT should exist');
  assert.equal(reel6.creator?.username, 'bhaavyaa____', 'Creator username must be parsed from Owner.Username');
  assert.equal(reel6.caption, 'Ajeeb.', 'Caption should be parsed from Caption label');
  assert.equal(reel6.instagram_media_id, '18084562202346176', 'Media ID should be fbid');

  // Test 7: Meta Latin-1 UTF-8 mojibake decoding + BMP-truncated PUA cleanup + Repository.queryCreators bounding/pinning
  console.log('Test 7: Meta mojibake normalization and bounded creator query');
  assert.equal(
    normalizeMetaExportText('thereâ\x80\x99s tears ð\x9F\x98\xad for Céline\uF5A4\uF90F\uF3FB\uE001'),
    'there’s tears 😭 for Céline'
  );
  assert.equal(
    normalizeMetaExportText('小coco来啰'),
    '小coco来啰',
    'Genuine CJK unified characters must never be stripped'
  );

  const mojibakeArchive = [
    {
      timestamp: 1794139000,
      fbid: '18084562202349999',
      label_values: [
        {
          label: 'URL',
          href: 'https://www.instagram.com/reel/Dfbw_JqgcN0/',
        },
        {
          label: 'Caption',
          value: 'thereâ\x80\x99s hope ð\x9F\x98\xad',
        },
        {
          title: 'Owner',
          dict: [
            {
              dict: [
                { label: 'Username', value: 'celine_Archive' },
                { label: 'Name', value: 'CÃ©lineâ\x80\x99s Vault' },
              ],
            },
          ],
        },
      ],
    },
  ];
  const res7 = await ArchiveImportService.importArchive(mojibakeArchive);
  assert.equal(res7.status, 'success');
  assert.equal(res7.reelsImported, 1);

  const { reels: list7 } = await Repository.getReels({ limit: 20 });
  const reel7 = list7.find((r) => r.shortcode === 'Dfbw_JqgcN0');
  assert.ok(reel7, 'Reel Dfbw_JqgcN0 should exist');
  assert.equal(reel7.caption, 'there’s hope 😭');
  assert.equal(reel7.creator?.display_name, 'Céline’s Vault');

  const atDisplaySearch = await Repository.getReels({ search: '@céline', limit: 20 });
  assert.equal(atDisplaySearch.reels.some((r) => r.shortcode === 'Dfbw_JqgcN0'), true, '@display_name search must match handleQ');

  const topBounded = await Repository.queryCreators({ limit: 2 });
  assert.equal(topBounded.creators.length, 2);
  assert.ok(topBounded.totalCount >= 4);
  assert.equal(topBounded.matchCount, topBounded.totalCount);

  const searchResult = await Repository.queryCreators({ q: '@bhaav', limit: 5 });
  assert.equal(searchResult.matchCount, 1);
  assert.equal(searchResult.creators[0]?.username, 'bhaavyaa____');

  const displayResult = await Repository.queryCreators({ q: 'céline', limit: 5 });
  assert.equal(displayResult.matchCount, 1);
  assert.equal(displayResult.creators[0]?.username, 'celine_Archive');

  const pinnedResult = await Repository.queryCreators({ limit: 1, includeId: reel7.creator_id });
  assert.equal(pinnedResult.creators.length, 1);
  assert.equal(pinnedResult.creators[0]?.id, reel7.creator_id);

  // Test 8: Media type isolation (/p/ posts vs /reel/ & /tv/ reels) and repository filtering
  console.log('Test 8: Media type isolation for /p/ posts vs /reel/ and /tv/ reels');
  const mixedMediaExport = {
    saved_saved_media: [
      {
        title: 'the_political_compass',
        string_map_data: {
          'Saved on': {
            href: 'https://www.instagram.com/p/DS1goOmjhUi/',
            timestamp: 1700001000,
          },
        },
      },
      {
        title: 'the_political_compass',
        string_map_data: {
          'Saved on': {
            href: 'https://www.instagram.com/the_political_compass/p/DUCwaqkjmvc/',
            timestamp: 1700001100,
          },
        },
      },
      {
        title: 'the_political_compass',
        string_map_data: {
          'Saved on': {
            href: 'https://www.instagram.com/reel/DT_x3F4Dj3-/',
            timestamp: 1700001200,
          },
        },
      },
      {
        title: 'the_political_compass',
        string_map_data: {
          'Saved on': {
            href: 'https://www.instagram.com/tv/DIgtv123456/',
            timestamp: 1700001300,
          },
        },
      },
    ],
  };

  const res8 = await ArchiveImportService.importArchive(mixedMediaExport);
  assert.equal(res8.status, 'success');
  assert.equal(res8.reelsImported, 4);

  const { reels: postsOnly, total: totalPostsFiltered } = await Repository.getReels({
    mediaType: 'post',
    limit: 50,
  });
  assert.equal(totalPostsFiltered, 2, 'Expected exact count of 2 saved posts');
  assert.ok(postsOnly.every((item) => item.media_type === 'post'), 'Every item under mediaType=post must be a post');

  const post1 = postsOnly.find((item) => item.shortcode === 'DS1goOmjhUi');
  const post2 = postsOnly.find((item) => item.shortcode === 'DUCwaqkjmvc');
  assert.equal(post1?.reel_url, 'https://www.instagram.com/p/DS1goOmjhUi/');
  assert.equal(post2?.reel_url, 'https://www.instagram.com/p/DUCwaqkjmvc/');

  const { reels: reelsOnly, total: totalReelsFiltered } = await Repository.getReels({
    mediaType: 'reel',
    limit: 50,
  });
  assert.ok(totalReelsFiltered >= 2);
  assert.ok(reelsOnly.every((item) => item.media_type === 'reel'), 'Every item under mediaType=reel must be a reel');

  const importedReel = reelsOnly.find((item) => item.shortcode === 'DT_x3F4Dj3-');
  const importedTv = reelsOnly.find((item) => item.shortcode === 'DIgtv123456');
  assert.equal(importedReel?.reel_url, 'https://www.instagram.com/reel/DT_x3F4Dj3-/');
  assert.equal(importedTv?.reel_url, 'https://www.instagram.com/tv/DIgtv123456/');

  const statsAfterMixed = await Repository.getStats();
  assert.equal(statsAfterMixed.postsCount, 2);
  assert.equal(statsAfterMixed.reelsCount, totalReelsFiltered);
  assert.equal(statsAfterMixed.totalReels, statsAfterMixed.reelsCount + statsAfterMixed.postsCount);

  // Test 9: One-off legacy DM post recovery (rewritten /reel/ -> canonical /p/ + media_type='post')
  console.log('Test 9: Legacy DM post recovery script & Repository classification repair');
  const { recoverLegacyPosts } = await import('../scripts/recover-legacy-posts.ts');
  Repository.resetMemoryStoreForTests();

  const legacyCreator = await Repository.upsertCreator({
    instagram_user_id: 'creator_legacy_dm',
    username: 'legacy_dm_creator',
    display_name: 'Legacy DM Creator',
  });

  // 1) Legacy DM post stored with rewritten /reel/ URL
  await Repository.upsertSavedReel({
    instagram_media_id: 'shortcode_DLegacyPost1',
    shortcode: 'DLegacyPost1',
    reel_url: 'https://www.instagram.com/reel/DLegacyPost1/',
    media_type: 'reel',
    creator_id: legacyCreator.id,
    caption: 'Legacy DM post',
    taken_at: '2026-11-10T09:00:00Z',
    first_detected_at: '2026-11-10T09:03:00Z',
    save_order_rank: 1,
  });

  // 2) Genuine reel stored with /reel/ URL
  await Repository.upsertSavedReel({
    instagram_media_id: 'shortcode_DLegacyReel1',
    shortcode: 'DLegacyReel1',
    reel_url: 'https://www.instagram.com/reel/DLegacyReel1/',
    media_type: 'reel',
    creator_id: legacyCreator.id,
    caption: 'Genuine reel',
    taken_at: '2026-11-10T08:00:00Z',
    first_detected_at: '2026-11-10T08:00:00Z',
    save_order_rank: 2,
  });

  // 3) Unresolved item (transient network failure -> must stay untouched for retry)
  await Repository.upsertSavedReel({
    instagram_media_id: 'shortcode_DLegacyUnres',
    shortcode: 'DLegacyUnres',
    reel_url: 'https://www.instagram.com/reel/DLegacyUnres/',
    media_type: 'reel',
    creator_id: legacyCreator.id,
    caption: 'Unresolved item',
    taken_at: '2026-11-10T07:00:00Z',
    first_detected_at: '2026-11-10T07:00:00Z',
    save_order_rank: 3,
  });

  const mockResolver = async (shortcode: string) => {
    if (shortcode === 'DLegacyPost1') return { isClips: false, mediaKind: 'FEED' as const };
    if (shortcode === 'DLegacyReel1') return { isClips: true, mediaKind: 'CLIPS' as const };
    return {};
  };

  // Dry run must NOT mutate rows
  const drySummary = await recoverLegacyPosts({
    limit: 10,
    pageSize: 2,
    delayMs: 0,
    dryRun: true,
    resolver: mockResolver,
  });
  assert.deepEqual(drySummary, {
    scanned: 3,
    recoveredPosts: 1,
    confirmedReels: 1,
    unresolved: 1,
    updated: 0,
  });
  assert.equal((await Repository.getLegacyReelUrlCandidates({ limit: 10 })).length, 3);

  // Real run updates DLegacyPost1 to media_type='post' & /p/ URL, leaving DLegacyReel1 and DLegacyUnres intact
  const liveSummary = await recoverLegacyPosts({
    limit: 10,
    pageSize: 2,
    delayMs: 0,
    dryRun: false,
    resolver: mockResolver,
  });
  assert.deepEqual(liveSummary, {
    scanned: 3,
    recoveredPosts: 1,
    confirmedReels: 1,
    unresolved: 1,
    updated: 1,
  });

  const postCheck = await Repository.getReels({ mediaType: 'post', limit: 10 });
  assert.equal(postCheck.total, 1);
  assert.equal(postCheck.reels[0].shortcode, 'DLegacyPost1');
  assert.equal(postCheck.reels[0].media_type, 'post');
  assert.equal(postCheck.reels[0].reel_url, 'https://www.instagram.com/p/DLegacyPost1/');

  // Recovered post drops out of legacy /reel/ candidates so reruns only retry remaining items
  const remainingCandidates = await Repository.getLegacyReelUrlCandidates({ limit: 10 });
  assert.deepEqual(
    remainingCandidates.map((c) => c.shortcode),
    ['DLegacyReel1', 'DLegacyUnres']
  );

  console.log('✅ All ArchiveImportService tests passed successfully!');
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
