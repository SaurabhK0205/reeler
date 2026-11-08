import assert from 'node:assert/strict';
import { ArchiveImportService } from '../src/services/archiveImportService.ts';
import { Repository } from '../src/db/repository.ts';

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
  assert.equal(res3.reelsImported, 1);

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

  console.log('✅ All ArchiveImportService tests passed successfully!');
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
