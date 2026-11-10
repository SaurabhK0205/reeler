import assert from 'node:assert';
import { test } from 'node:test';
import { MetaInstagramBotService } from '../src/services/metaInstagramBotService.ts';

test('MetaInstagramBotService - splitMessageIntoChunks handles short and empty text', () => {
  const service = new MetaInstagramBotService();

  assert.deepStrictEqual(service.splitMessageIntoChunks('', 100), []);
  assert.deepStrictEqual(service.splitMessageIntoChunks('hello world', 100), ['hello world']);
});

test('MetaInstagramBotService - splitMessageIntoChunks splits multi-paragraph messages cleanly', () => {
  const service = new MetaInstagramBotService();
  const p1 = 'Paragraph 1: ' + 'A'.repeat(50);
  const p2 = 'Paragraph 2: ' + 'B'.repeat(50);
  const p3 = 'Paragraph 3: ' + 'C'.repeat(50);
  const text = `${p1}\n\n${p2}\n\n${p3}`;

  const chunks = service.splitMessageIntoChunks(text, 90);
  assert.ok(chunks.length >= 3, `Expected at least 3 chunks, got ${chunks.length}`);
  for (const c of chunks) {
    assert.ok(c.length <= 90, `Chunk exceeds maxLen: length ${c.length} > 90`);
    assert.ok(c.trim().length > 0, 'Chunk should not be empty or whitespace');
  }
});

test('MetaInstagramBotService - splitMessageIntoChunks handles huge single paragraph and leading whitespace', () => {
  const service = new MetaInstagramBotService();
  const hugePara = '   \n\n   ' + 'Word '.repeat(300);
  const trailingPara = 'Final short note';
  const text = `${hugePara}\n\n${trailingPara}`;

  const chunks = service.splitMessageIntoChunks(text, 200);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(c.length <= 200, `Chunk length ${c.length} exceeds 200`);
    assert.ok(c.trim().length > 0, 'Chunk should not be empty');
  }
  assert.ok(chunks[chunks.length - 1].includes('Final short note'));
});

test('MetaInstagramBotService - splitMessageIntoChunks handles unbroken string without spaces or newlines', () => {
  const service = new MetaInstagramBotService();
  const unbroken = 'X'.repeat(500);

  const chunks = service.splitMessageIntoChunks(unbroken, 100);
  assert.strictEqual(chunks.length, 5);
  for (const c of chunks) {
    assert.strictEqual(c.length, 100);
  }
});

test('extractCreatorQuery - extracts handles accurately including underscores and actions', async () => {
  const { extractCreatorQuery } = await import('../src/utils/creatorQuery.ts');

  assert.strictEqual(extractCreatorQuery('@_docthor_'), '_docthor_');
  assert.strictEqual(extractCreatorQuery('@stop.motion'), 'stop.motion');
  assert.strictEqual(extractCreatorQuery('reels by @_docthor_'), '_docthor_');
  assert.strictEqual(extractCreatorQuery('reels by @stop.motion'), 'stop.motion');
  assert.strictEqual(extractCreatorQuery('reels from _docthor_'), '_docthor_');
  assert.strictEqual(extractCreatorQuery('_docthor_'), '_docthor_');
  assert.strictEqual(extractCreatorQuery('hello'), null);
  assert.strictEqual(extractCreatorQuery('watched'), null);
  assert.strictEqual(extractCreatorQuery('unsub'), null);
  assert.strictEqual(extractCreatorQuery('unsubscribe'), null);
  assert.strictEqual(extractCreatorQuery('show all'), null);
  assert.strictEqual(extractCreatorQuery('find help'), null);
  assert.strictEqual(extractCreatorQuery('show 2h'), null);
  assert.strictEqual(extractCreatorQuery('@..'), null);
  assert.strictEqual(extractCreatorQuery('..'), null);
  assert.strictEqual(extractCreatorQuery('.'), null);
  assert.strictEqual(extractCreatorQuery('looking..game'), null);
});

test('reelMessages - parseWatchedStopCommand separates single vs bulk commands without capturing creator lookups or durations', async () => {
  const { parseWatchedStopCommand } = await import('../src/utils/reelMessages.ts');

  assert.deepStrictEqual(parseWatchedStopCommand('Watched'), { isCommand: true, markAll: false });
  assert.deepStrictEqual(parseWatchedStopCommand('watched!'), { isCommand: true, markAll: false });
  assert.deepStrictEqual(parseWatchedStopCommand('done with it'), { isCommand: true, markAll: false });
  assert.deepStrictEqual(parseWatchedStopCommand('stop'), { isCommand: true, markAll: false });
  assert.deepStrictEqual(parseWatchedStopCommand('stop reminder'), { isCommand: true, markAll: false });
  assert.deepStrictEqual(parseWatchedStopCommand('watch'), { isCommand: true, markAll: false });

  assert.deepStrictEqual(parseWatchedStopCommand('stop all'), { isCommand: true, markAll: true });
  assert.deepStrictEqual(parseWatchedStopCommand('watched all'), { isCommand: true, markAll: true });
  assert.deepStrictEqual(parseWatchedStopCommand('mark all as watched'), { isCommand: true, markAll: true });
  assert.deepStrictEqual(parseWatchedStopCommand('clear all'), { isCommand: true, markAll: true });
  assert.deepStrictEqual(parseWatchedStopCommand('stop reminders'), { isCommand: true, markAll: true });
  assert.deepStrictEqual(parseWatchedStopCommand('cancel reminders'), { isCommand: true, markAll: true });
  assert.deepStrictEqual(parseWatchedStopCommand('unsub'), { isCommand: true, markAll: true });
  assert.deepStrictEqual(parseWatchedStopCommand('unsubscribe'), { isCommand: true, markAll: true });

  // Creator-lookup handles must NOT be misclassified as watched/stop commands
  assert.deepStrictEqual(parseWatchedStopCommand('@stop.motion'), { isCommand: false, markAll: false });
  assert.deepStrictEqual(parseWatchedStopCommand('stop.motion'), { isCommand: false, markAll: false });
  assert.deepStrictEqual(parseWatchedStopCommand('reels by @done'), { isCommand: false, markAll: false });
  assert.deepStrictEqual(parseWatchedStopCommand('show @done'), { isCommand: false, markAll: false });

  assert.deepStrictEqual(parseWatchedStopCommand('watch in 5m'), { isCommand: false, markAll: false });
  assert.deepStrictEqual(parseWatchedStopCommand('remind me in 10 minutes'), { isCommand: false, markAll: false });
  assert.deepStrictEqual(parseWatchedStopCommand('hello'), { isCommand: false, markAll: false });
  assert.deepStrictEqual(parseWatchedStopCommand(''), { isCommand: false, markAll: false });
});

test('reelMessages - clickable creator profile URL & Reel preview priority', async () => {
  const {
    extractPublicCreatorUsername,
    formatWatchLaterReminderMessage,
    formatCreatorSearchMessages,
    formatReminderSetMessage,
  } = await import('../src/utils/reelMessages.ts');

  assert.strictEqual(extractPublicCreatorUsername({ username: '@lookingforgame', display_name: 'Looking For Game' }), 'lookingforgame');
  assert.strictEqual(extractPublicCreatorUsername({ username: 'a', display_name: null }), 'a');
  assert.strictEqual(extractPublicCreatorUsername({ username: '_docthor_', display_name: null }), '_docthor_');
  assert.strictEqual(extractPublicCreatorUsername({ username: '.', display_name: null }), null);
  assert.strictEqual(extractPublicCreatorUsername({ username: '..', display_name: null }), null);
  assert.strictEqual(extractPublicCreatorUsername({ username: '@..', display_name: null }), null);
  assert.strictEqual(extractPublicCreatorUsername({ username: '@.', display_name: null }), null);
  assert.strictEqual(extractPublicCreatorUsername({ username: '.leading', display_name: null }), null);
  assert.strictEqual(extractPublicCreatorUsername({ username: 'trailing.', display_name: null }), null);
  assert.strictEqual(extractPublicCreatorUsername({ username: 'Instagram Creator', display_name: 'Instagram Creator' }), null);
  assert.strictEqual(extractPublicCreatorUsername({ username: 'instagram_creator', display_name: null }), null);
  assert.strictEqual(extractPublicCreatorUsername({ username: 'instagram_user', display_name: 'instagram_user' }), null);
  assert.strictEqual(extractPublicCreatorUsername({ username: 'Invalid Space', display_name: 'Invalid Space' }), null);

  const reminderText = formatWatchLaterReminderMessage({
    reel_url: 'https://www.instagram.com/reel/Dfi55BqRIxb/',
    caption: 'Five indie video games you need to play this week before GTA 6 including Casualties 🎮🔥',
    creator: {
      id: 'c1',
      instagram_user_id: 'ig1',
      username: 'lookingforgame',
      display_name: 'Looking For Game',
      created_at: '2026-11-10T00:00:00Z',
      updated_at: '2026-11-10T00:00:00Z',
    },
  });

  const reelUrlIndex = reminderText.indexOf('https://www.instagram.com/reel/Dfi55BqRIxb/');
  const profileUrlIndex = reminderText.indexOf('https://www.instagram.com/lookingforgame/');
  assert.ok(reelUrlIndex !== -1, 'Reminder must contain Reel URL');
  assert.ok(profileUrlIndex !== -1, 'Reminder must contain clickable Creator Profile URL');
  assert.ok(reelUrlIndex < profileUrlIndex, 'Reel URL MUST appear before Creator Profile URL to preserve Reel card preview');
  assert.ok(reminderText.includes('@lookingforgame'));
  assert.ok(reminderText.length <= 950, `Reminder length ${reminderText.length} exceeds safe DM limit`);

  const placeholderReminder = formatWatchLaterReminderMessage({
    reel_url: 'https://www.instagram.com/reel/Dfi55BqRIxb/',
    caption: null,
    creator: {
      id: 'c2',
      instagram_user_id: 'ig2',
      username: 'Instagram Creator',
      display_name: 'Instagram Creator',
      created_at: '2026-11-10T00:00:00Z',
      updated_at: '2026-11-10T00:00:00Z',
    },
  });
  assert.ok(!placeholderReminder.includes('instagram.com/Instagram'), 'Must never construct invalid profile URLs for placeholders');

  const setReply = formatReminderSetMessage(
    {
      caption: 'Sample caption',
      creator: {
        id: 'c1',
        instagram_user_id: 'ig1',
        username: 'lookingforgame',
        display_name: 'Looking For Game',
        created_at: '2026-11-10T00:00:00Z',
        updated_at: '2026-11-10T00:00:00Z',
      },
    },
    '30 seconds',
    'today at 10:10:55 AM'
  );
  assert.ok(setReply.includes('@lookingforgame'));
  assert.ok(setReply.includes('https://www.instagram.com/lookingforgame/'));

  const searchCopy = formatCreatorSearchMessages({
    username: 'lookingforgame',
    displayName: 'Looking For Game',
    totalCount: 8,
    limit: 5,
  });
  assert.ok(searchCopy.header.includes('https://www.instagram.com/lookingforgame/'));
  assert.ok(searchCopy.footer.includes('https://www.instagram.com/lookingforgame/'));
  assert.ok(searchCopy.notFound.includes('https://www.instagram.com/lookingforgame/'));
});

test('reelMessages - confirmation messages never expose shortcodes & split UTF-16 surrogates safely', async () => {
  const { formatWatchedConfirmationMessage, formatHumanCaptionSnippet } = await import('../src/utils/reelMessages.ts');

  const emojiCaption = 'Top games '.padEnd(42, 'a') + ' 🎮🔥🕹️✨';
  const snippet = formatHumanCaptionSnippet(emojiCaption, 46);
  assert.ok(snippet);
  assert.ok(!/[\uD800-\uDBFF]$/.test(snippet.replace(/\.\.\.$/, '')), 'Must not truncate mid-surrogate pair');

  const reelMock = {
    id: 'r1',
    instagram_media_id: 'shortcode_Dfi55BqRIxb',
    shortcode: 'Dfi55BqRIxb',
    reel_url: 'https://www.instagram.com/reel/Dfi55BqRIxb/',
    creator_id: 'c1',
    caption: 'Five indie video games you need to play this week',
    taken_at: '2026-11-10T00:00:00Z',
    first_detected_at: '2026-11-10T00:00:00Z',
    save_order_rank: 1,
    watch_status: 'watched' as const,
    reminders_sent_count: 1,
    is_saved_on_instagram: true,
    is_unavailable: false,
    created_at: '2026-11-10T00:00:00Z',
    updated_at: '2026-11-10T00:00:00Z',
    creator: {
      id: 'c1',
      instagram_user_id: 'ig1',
      username: 'lookingforgame',
      created_at: '2026-11-10T00:00:00Z',
      updated_at: '2026-11-10T00:00:00Z',
    },
  };

  const singleWithRemaining = formatWatchedConfirmationMessage([reelMock], 2, false);
  assert.ok(!singleWithRemaining.includes('Dfi55BqRIxb'), 'Must never leak shortcode in watched confirmation');
  assert.ok(singleWithRemaining.includes('@lookingforgame'));
  assert.ok(singleWithRemaining.includes('2 other Watch Later reminders active'));
  assert.ok(singleWithRemaining.includes('stop all'));

  const unattributedNoCaption = formatWatchedConfirmationMessage(
    [
      {
        ...reelMock,
        shortcode: 'Da1iWbSMAOz',
        caption: null,
        creator: undefined,
      },
    ],
    0,
    false
  );
  assert.ok(!unattributedNoCaption.includes('Da1iWbSMAOz'), 'Fallback confirmation must not leak shortcode');
  assert.ok(unattributedNoCaption.includes('your saved reel'));

  const secondReelMock = {
    ...reelMock,
    id: 'r2',
    shortcode: 'SECONDREEL1',
  };
  const partialMarkAll = formatWatchedConfirmationMessage([reelMock, secondReelMock], 3, true);
  assert.ok(partialMarkAll.includes('Marked 2 pending reels as watched'));
  assert.ok(partialMarkAll.includes('3 other Watch Later reminders remain active'));
  assert.ok(!partialMarkAll.includes('Marked all'));

  const longDisplayCreator = {
    id: 'c_long',
    instagram_user_id: 'ig_long',
    username: 'Instagram Creator',
    display_name: 'Very Long Studio Collective '.repeat(6),
    created_at: '2026-11-10T00:00:00Z',
    updated_at: '2026-11-10T00:00:00Z',
  };
  const longDisplayConfirm = formatWatchedConfirmationMessage(
    [{ ...reelMock, creator: longDisplayCreator, caption: 'Long display name test' }],
    0,
    false
  );
  assert.ok(longDisplayConfirm.length <= 950, `Expected <= 950 chars, got ${longDisplayConfirm.length}`);
  assert.ok(!longDisplayConfirm.includes('Dfi55BqRIxb'));
});

test('Repository + MetaInstagramBotService - marks most recently reminded reel instead of older pending reel and avoids sender leakage', async () => {
  const prevUrl = process.env.SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  try {
    const { Repository } = await import('../src/db/repository.ts');
    Repository.resetMemoryStoreForTests();

    const oldCreator = await Repository.upsertCreator({
      instagram_user_id: 'creator_old',
      username: 'oldercreator',
      display_name: 'Older Creator',
    });
    const newCreator = await Repository.upsertCreator({
      instagram_user_id: 'creator_lookingforgame',
      username: 'lookingforgame',
      display_name: 'Looking For Game',
    });
    const otherCreator = await Repository.upsertCreator({
      instagram_user_id: 'creator_other',
      username: 'someoneelse',
      display_name: 'Someone Else',
    });

    await Repository.upsertSavedReel({
      instagram_media_id: 'shortcode_Da1iWbSMAOz',
      shortcode: 'Da1iWbSMAOz',
      reel_url: 'https://www.instagram.com/reel/Da1iWbSMAOz/',
      creator_id: oldCreator.id,
      caption: 'Old pending reel from yesterday',
      taken_at: '2026-11-09T10:00:00Z',
      first_detected_at: '2026-11-09T10:00:00Z',
      save_order_rank: 2,
      watch_status: 'watch_later',
      next_reminder_at: '2026-11-10T18:00:00Z',
      instagram_sender_id: 'sender_123',
    });

    // Wait briefly or record reminder later so Dfi55BqRIxb has strictly newer reminder/update timestamp
    await new Promise((r) => setTimeout(r, 15));

    const recentReel = await Repository.upsertSavedReel({
      instagram_media_id: 'shortcode_Dfi55BqRIxb',
      shortcode: 'Dfi55BqRIxb',
      reel_url: 'https://www.instagram.com/reel/Dfi55BqRIxb/',
      creator_id: newCreator.id,
      caption: 'Five indie video games you need to play this week',
      taken_at: '2026-11-10T10:00:00Z',
      first_detected_at: '2026-11-10T10:00:00Z',
      save_order_rank: 1,
      watch_status: 'watch_later',
      next_reminder_at: '2026-11-10T10:10:55Z',
      instagram_sender_id: 'sender_123',
    });
    assert.ok(recentReel);
    await Repository.recordReminderSent(recentReel.id, null);

    // Another user's active Watch Later reel must remain isolated
    await Repository.upsertSavedReel({
      instagram_media_id: 'shortcode_OTHER999999',
      shortcode: 'OTHER999999',
      reel_url: 'https://www.instagram.com/reel/OTHER999999/',
      creator_id: otherCreator.id,
      caption: 'Belongs to another sender',
      taken_at: '2026-11-10T10:05:00Z',
      first_detected_at: '2026-11-10T10:05:00Z',
      save_order_rank: 1,
      watch_status: 'watch_later',
      next_reminder_at: '2026-11-10T20:00:00Z',
      instagram_sender_id: 'sender_999',
    });

    const sentMessages: Array<{ recipientId: string; text: string }> = [];
    const bot = new MetaInstagramBotService();
    bot.sendDirectMessage = async (recipientId: string, text: string) => {
      sentMessages.push({ recipientId, text });
      return true;
    };

    // 1. User replies "Watched" -> should mark ONLY Dfi55BqRIxb and mention remaining count (1)
    await bot.handleWebhookPayload({
      object: 'instagram',
      entry: [
        {
          messaging: [
            {
              sender: { id: 'sender_123' },
              message: { text: 'Watched' },
            },
          ],
        },
      ],
    });

    assert.strictEqual(sentMessages.length, 1);
    const firstReply = sentMessages[0].text;
    assert.ok(firstReply.includes('@lookingforgame'), `Expected @lookingforgame in "${firstReply}"`);
    assert.ok(!firstReply.includes('Da1iWbSMAOz'), `Must not mention older shortcode Da1iWbSMAOz in "${firstReply}"`);
    assert.ok(!firstReply.includes('Dfi55BqRIxb'), `Must not leak shortcode Dfi55BqRIxb in "${firstReply}"`);
    assert.ok(firstReply.includes('1 other Watch Later reminder active'), `Expected remaining hint in "${firstReply}"`);

    // 2. User replies "stop all" -> marks the remaining older reel without touching sender_999
    await bot.handleWebhookPayload({
      object: 'instagram',
      entry: [
        {
          messaging: [
            {
              sender: { id: 'sender_123' },
              message: { text: 'stop all' },
            },
          ],
        },
      ],
    });

    assert.strictEqual(sentMessages.length, 2);
    const secondReply = sentMessages[1].text;
    assert.ok(secondReply.includes('@oldercreator'));
    assert.ok(!secondReply.includes('Da1iWbSMAOz'));

    // 3. Another reply "Watched" from sender_123 when queue is empty must NOT touch sender_999
    await bot.handleWebhookPayload({
      object: 'instagram',
      entry: [
        {
          messaging: [
            {
              sender: { id: 'sender_123' },
              message: { text: 'Watched' },
            },
          ],
        },
      ],
    });

    assert.strictEqual(sentMessages.length, 3);
    assert.ok(sentMessages[2].text.includes('No pending reels right now'));

    const otherCheck = await Repository.markWatchedForInstagramSender('sender_999');
    assert.strictEqual(otherCheck.updatedReels.length, 1);
    assert.strictEqual(otherCheck.updatedReels[0].shortcode, 'OTHER999999');

    // 4. Custom duration DM reply targets newly awaiting reel & includes clickable profile link cleanly
    await Repository.upsertSavedReel({
      instagram_media_id: 'shortcode_Dfi55BqRIxb',
      shortcode: 'Dfi55BqRIxb',
      reel_url: 'https://www.instagram.com/reel/Dfi55BqRIxb/',
      creator_id: newCreator.id,
      caption: 'Five indie video games you need to play this week',
      taken_at: '2026-11-10T10:15:00Z',
      first_detected_at: '2026-11-10T10:15:00Z',
      save_order_rank: 1,
      watch_status: 'watch_later',
      awaiting_reminder_choice_until: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      instagram_sender_id: 'sender_123',
    });

    await bot.handleWebhookPayload({
      object: 'instagram',
      entry: [
        {
          messaging: [
            {
              sender: { id: 'sender_123' },
              message: { text: '5m' },
            },
          ],
        },
      ],
    });
    assert.strictEqual(sentMessages.length, 4);
    assert.ok(sentMessages[3].text.includes('@lookingforgame'));
    assert.ok(sentMessages[3].text.includes('https://www.instagram.com/lookingforgame/'));

    // 5. Creator query DM includes clickable profile link cleanly
    await bot.handleWebhookPayload({
      object: 'instagram',
      entry: [
        {
          messaging: [
            {
              sender: { id: 'sender_123' },
              message: { text: '@lookingforgame' },
            },
          ],
        },
      ],
    });
    assert.ok(sentMessages.length >= 6);
    assert.ok(sentMessages[4].text.includes('https://www.instagram.com/lookingforgame/'));
    assert.strictEqual(sentMessages[5].text, 'https://www.instagram.com/reel/Dfi55BqRIxb/');

    Repository.resetMemoryStoreForTests();
  } finally {
    if (prevUrl !== undefined) process.env.SUPABASE_URL = prevUrl;
    if (prevKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
  }
});

test('Repository.getLastReelForInstagramSender - ignores non-watch_later archive rows & respects sender isolation', async () => {
  const prevUrl = process.env.SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  try {
    const { Repository } = await import('../src/db/repository.ts');
    Repository.resetMemoryStoreForTests();

    const c = await Repository.upsertCreator({
      instagram_user_id: 'creator_iso',
      username: 'iso_creator',
      display_name: 'Iso Creator',
    });

    // Newer archived/unwatched and watched rows must NOT shadow an active watch_later reel
    await Repository.upsertSavedReel({
      instagram_media_id: 'shortcode_UNWATCHED1',
      shortcode: 'UNWATCHED1',
      reel_url: 'https://www.instagram.com/reel/UNWATCHED1/',
      creator_id: c.id,
      caption: 'Unwatched archive item',
      taken_at: '2026-11-10T11:00:00Z',
      first_detected_at: '2026-11-10T11:00:00Z',
      save_order_rank: 1,
      watch_status: 'unwatched',
      instagram_sender_id: 'sender_alpha',
    });

    const olderWatchLater = await Repository.upsertSavedReel({
      instagram_media_id: 'shortcode_WLOLDER1',
      shortcode: 'WLOLDER1',
      reel_url: 'https://www.instagram.com/reel/WLOLDER1/',
      creator_id: c.id,
      caption: 'Older active queue item',
      taken_at: '2026-11-10T09:00:00Z',
      first_detected_at: '2026-11-10T09:00:00Z',
      save_order_rank: 2,
      watch_status: 'watch_later',
      instagram_sender_id: 'sender_alpha',
    });

    await new Promise((r) => setTimeout(r, 15));

    const newerWatchLater = await Repository.upsertSavedReel({
      instagram_media_id: 'shortcode_WLNEWER1',
      shortcode: 'WLNEWER1',
      reel_url: 'https://www.instagram.com/reel/WLNEWER1/',
      creator_id: c.id,
      caption: 'Newer active queue item',
      taken_at: '2026-11-10T10:00:00Z',
      first_detected_at: '2026-11-10T10:00:00Z',
      save_order_rank: 1,
      watch_status: 'watch_later',
      instagram_sender_id: 'sender_alpha',
    });
    assert.ok(olderWatchLater && newerWatchLater);
    await Repository.recordReminderSent(olderWatchLater.id, null);

    // Most recently reminded reel (olderWatchLater) wins over earlier saved newerWatchLater
    const lastForAlpha = await Repository.getLastReelForInstagramSender('sender_alpha');
    assert.strictEqual(lastForAlpha?.shortcode, 'WLOLDER1');

    // Empty senderId must NEVER touch sender_alpha's attributed rows when unattributed queue is empty
    const emptySenderResult = await Repository.getLastReelForInstagramSender('');
    assert.strictEqual(emptySenderResult, null);

    // Unattributed watch_later reel IS visible for empty sender without touching sender_alpha
    await Repository.upsertSavedReel({
      instagram_media_id: 'shortcode_WLUNATTR',
      shortcode: 'WLUNATTR',
      reel_url: 'https://www.instagram.com/reel/WLUNATTR/',
      creator_id: c.id,
      caption: 'Unattributed watch later',
      taken_at: '2026-11-10T12:00:00Z',
      first_detected_at: '2026-11-10T12:00:00Z',
      save_order_rank: 1,
      watch_status: 'watch_later',
      instagram_sender_id: null,
    });
    const unattrResult = await Repository.getLastReelForInstagramSender('');
    assert.strictEqual(unattrResult?.shortcode, 'WLUNATTR');

    Repository.resetMemoryStoreForTests();
  } finally {
    if (prevUrl !== undefined) process.env.SUPABASE_URL = prevUrl;
    if (prevKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
  }
});

test('MetaInstagramBotService.handleWebhookPayload - displayName-only metadata stores Instagram Creator placeholder and omits profile URL', async () => {
  const prevUrl = process.env.SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const originalFetch = globalThis.fetch;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  try {
    const { Repository } = await import('../src/db/repository.ts');
    Repository.resetMemoryStoreForTests();

    globalThis.fetch = async () =>
      new Response(
        `<html><head>
          <meta property="og:url" content="https://www.instagram.com/reel/DNoUser1234/" />
          <meta property="og:title" content="Creative Studio on Instagram" />
          <meta property="og:description" content="120 likes: &quot;Short demo clip&quot;." />
        </head></html>`,
        { status: 200, headers: { 'Content-Type': 'text/html' } }
      );

    const sentMessages: Array<{ recipientId: string; text: string }> = [];
    const bot = new MetaInstagramBotService();
    bot.sendDirectMessage = async (recipientId: string, text: string) => {
      sentMessages.push({ recipientId, text });
      return true;
    };

    await bot.handleWebhookPayload({
      object: 'instagram',
      entry: [
        {
          messaging: [
            {
              sender: { id: 'sender_meta_only' },
              message: { text: 'https://www.instagram.com/reel/DNoUser1234/ 10m' },
            },
          ],
        },
      ],
    });

    assert.strictEqual(sentMessages.length, 1);
    const reply = sentMessages[0].text;
    assert.ok(reply.includes('Creator: Creative Studio'), `Expected clean display name in "${reply}"`);
    assert.ok(!reply.includes('instagram.com/Creative'), `Must never emit invalid profile URL for displayName in "${reply}"`);
    assert.ok(!reply.includes('👤 Profile:'), `Must omit profile line when no public username exists in "${reply}"`);

    const stored = await Repository.getReels({ page: 1, limit: 10 });
    assert.strictEqual(stored.reels.length, 1);
    assert.strictEqual(stored.reels[0].creator?.username, 'Instagram Creator');
    assert.strictEqual(stored.reels[0].creator?.display_name, 'Creative Studio');

    Repository.resetMemoryStoreForTests();
  } finally {
    globalThis.fetch = originalFetch;
    if (prevUrl !== undefined) process.env.SUPABASE_URL = prevUrl;
    if (prevKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
  }
});
