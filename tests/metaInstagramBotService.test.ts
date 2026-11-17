import assert from 'node:assert';
import { test } from 'node:test';
import {
  MetaInstagramBotService,
  isMetaMessagingWindowError,
} from '../src/services/metaInstagramBotService.ts';

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
  assert.deepStrictEqual(parseWatchedStopCommand('watched them all'), { isCommand: true, markAll: true });
  assert.deepStrictEqual(parseWatchedStopCommand('mark all as watched'), { isCommand: true, markAll: true });
  assert.deepStrictEqual(parseWatchedStopCommand('mark everything as watched'), { isCommand: true, markAll: true });
  assert.deepStrictEqual(parseWatchedStopCommand('clear all'), { isCommand: true, markAll: true });
  assert.deepStrictEqual(parseWatchedStopCommand('clear everything'), { isCommand: true, markAll: true });
  assert.deepStrictEqual(parseWatchedStopCommand('stop reminders'), { isCommand: true, markAll: true });
  assert.deepStrictEqual(parseWatchedStopCommand('cancel reminders'), { isCommand: true, markAll: true });
  assert.deepStrictEqual(parseWatchedStopCommand('unsub'), { isCommand: true, markAll: true });
  assert.deepStrictEqual(parseWatchedStopCommand('unsubscribe'), { isCommand: true, markAll: true });

  // Single-reel completions mentioning "all" incidentally must NOT wipe the entire Watch Later queue
  assert.deepStrictEqual(parseWatchedStopCommand('Watched! Thanks for all the reminders'), { isCommand: true, markAll: false });
  assert.deepStrictEqual(parseWatchedStopCommand('done with it all'), { isCommand: true, markAll: false });
  assert.deepStrictEqual(parseWatchedStopCommand('all done'), { isCommand: true, markAll: false });

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
    Object.defineProperty(bot, 'isConfigured', { get: () => true });
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

    // Empty senderId must NEVER touch sender_alpha's attributed rows or unattributed rows without explicit opt-in
    const emptySenderResult = await Repository.getLastReelForInstagramSender('');
    assert.strictEqual(emptySenderResult, null);

    // Unattributed watch_later reel must NOT be accessible or modifiable by external webhook senders
    await Repository.upsertSavedReel({
      instagram_media_id: 'shortcode_WLUNATTR',
      shortcode: 'WLUNATTR',
      reel_url: 'https://www.instagram.com/reel/WLUNATTR/',
      creator_id: c.id,
      caption: 'Unattributed admin watch later',
      taken_at: '2026-11-10T12:00:00Z',
      first_detected_at: '2026-11-10T12:00:00Z',
      save_order_rank: 1,
      watch_status: 'watch_later',
      instagram_sender_id: null,
    });

    assert.strictEqual(await Repository.getLastReelForInstagramSender('external_sender_without_queue'), null);
    const blockedMark = await Repository.markWatchedForInstagramSender('external_sender_without_queue', { markAll: true });
    assert.strictEqual(blockedMark.updatedReels.length, 0);

    // Webhook duration or "stop all" from a user with no queue must NOT reschedule or disclose unattributed admin reels
    const sentMessages: Array<{ recipientId: string; text: string }> = [];
    const bot = new MetaInstagramBotService();
    Object.defineProperty(bot, 'isConfigured', { get: () => true });
    bot.sendDirectMessage = async (recipientId: string, text: string) => {
      sentMessages.push({ recipientId, text });
      return true;
    };
    await bot.handleWebhookPayload({
      object: 'instagram',
      entry: [
        {
          messaging: [
            { sender: { id: 'external_sender_without_queue' }, message: { text: 'stop all' } },
            { sender: { id: 'external_sender_without_queue' }, message: { text: '5m' } },
          ],
        },
      ],
    });
    assert.ok(!sentMessages.some((m) => m.text.includes('Unattributed admin watch later')));
    assert.ok(!sentMessages.some((m) => m.text.includes('@iso_creator')));

    // Explicit opt-in (used by ReminderWorker.handleAdminMessage) still finds and marks unattributed admin reels
    const unattrResult = await Repository.getLastReelForInstagramSender('', { includeUnattributedFallback: true });
    assert.strictEqual(unattrResult?.shortcode, 'WLUNATTR');
    const adminMarked = await Repository.markWatchedForInstagramSender('', {
      markAll: true,
      includeUnattributedFallback: true,
    });
    assert.strictEqual(adminMarked.updatedReels.length, 1);
    assert.strictEqual(adminMarked.updatedReels[0].shortcode, 'WLUNATTR');

    // sender_alpha's attributed reels remain completely untouched
    const alphaStillActive = await Repository.getLastReelForInstagramSender('sender_alpha');
    assert.strictEqual(alphaStillActive?.shortcode, 'WLOLDER1');

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
    Object.defineProperty(bot, 'isConfigured', { get: () => true });
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
    assert.strictEqual(stored.reels[0].creator?.instagram_user_id, 'creator_unattributed_DNoUser1234');

    // A second handle-less reel (e.g. non-ASCII display name) must NOT collide or overwrite Creative Studio
    globalThis.fetch = async () =>
      new Response(
        `<html><head>
          <meta property="og:url" content="https://www.instagram.com/reel/DNonAscii123/" />
          <meta property="og:title" content="ज़रणेश on Instagram" />
          <meta property="og:description" content="50 likes: &quot;Second clip&quot;." />
        </head></html>`,
        { status: 200, headers: { 'Content-Type': 'text/html' } }
      );

    await bot.handleWebhookPayload({
      object: 'instagram',
      entry: [
        {
          messaging: [
            {
              sender: { id: 'sender_meta_only' },
              message: { text: 'https://www.instagram.com/reel/DNonAscii123/ 15m' },
            },
          ],
        },
      ],
    });

    const bothStored = await Repository.getReels({ page: 1, limit: 10 });
    assert.strictEqual(bothStored.reels.length, 2);
    const firstReel = bothStored.reels.find((r) => r.shortcode === 'DNoUser1234');
    const secondReel = bothStored.reels.find((r) => r.shortcode === 'DNonAscii123');
    assert.strictEqual(firstReel?.creator?.display_name, 'Creative Studio');
    assert.strictEqual(secondReel?.creator?.display_name, 'ज़रणेश');
    assert.notStrictEqual(firstReel?.creator_id, secondReel?.creator_id);

    Repository.resetMemoryStoreForTests();
  } finally {
    globalThis.fetch = originalFetch;
    if (prevUrl !== undefined) process.env.SUPABASE_URL = prevUrl;
    if (prevKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
  }
});

test('extractCreatorQueryWithFilter & parseWatchedStopCommand isolate reels vs posts queries', async () => {
  const { extractCreatorQueryWithFilter } = await import('../src/utils/creatorQuery.ts');
  const { parseWatchedStopCommand } = await import('../src/utils/reelMessages.ts');

  assert.deepStrictEqual(extractCreatorQueryWithFilter('the_political_compass'), {
    username: 'the_political_compass',
    mediaFilter: 'all',
  });
  assert.deepStrictEqual(extractCreatorQueryWithFilter('@the_political_compass'), {
    username: 'the_political_compass',
    mediaFilter: 'all',
  });
  assert.deepStrictEqual(extractCreatorQueryWithFilter('reels by @the_political_compass'), {
    username: 'the_political_compass',
    mediaFilter: 'reel',
  });
  assert.deepStrictEqual(extractCreatorQueryWithFilter('posts by @the_political_compass'), {
    username: 'the_political_compass',
    mediaFilter: 'post',
  });
  assert.deepStrictEqual(extractCreatorQueryWithFilter('the_political_compass posts'), {
    username: 'the_political_compass',
    mediaFilter: 'post',
  });
  assert.deepStrictEqual(extractCreatorQueryWithFilter('the_political_compass reels'), {
    username: 'the_political_compass',
    mediaFilter: 'reel',
  });
  assert.deepStrictEqual(extractCreatorQueryWithFilter('show posts from the_political_compass'), {
    username: 'the_political_compass',
    mediaFilter: 'post',
  });

  // Ensure post queries for handle "done" route to creator search rather than watch-stop
  assert.deepStrictEqual(parseWatchedStopCommand('posts by @done'), { isCommand: false, markAll: false });
  assert.deepStrictEqual(parseWatchedStopCommand('done posts'), { isCommand: false, markAll: false });
});

test('MetaInstagramBotService isolates /p/ posts vs /reel/ reels across save, reminder, watched, and creator search', async () => {
  const prevUrl = process.env.SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  const originalFetch = globalThis.fetch;
  try {
    const { Repository } = await import('../src/db/repository.ts');
    const { ReminderWorker } = await import('../src/services/reminderWorker.ts');
    Repository.resetMemoryStoreForTests();

    globalThis.fetch = (async (url: unknown) => {
      const target = String(url);
      if (target.includes('/p/DS1goOmjhUi/')) {
        return new Response(
          `<html><head>
            <meta property="og:url" content="https://www.instagram.com/the_political_compass/p/DS1goOmjhUi/" />
            <meta property="og:title" content="The Political Compass (@the_political_compass) on Instagram" />
            <meta property="og:description" content="120 likes: &quot;Quadrant meme post&quot;." />
          </head></html>`,
          { status: 200, headers: { 'Content-Type': 'text/html' } }
        );
      }
      if (target.includes('/reel/DT_x3F4Dj3-/')) {
        return new Response(
          `<html><head>
            <meta property="og:url" content="https://www.instagram.com/the_political_compass/reel/DT_x3F4Dj3-/" />
            <meta property="og:title" content="The Political Compass (@the_political_compass) on Instagram" />
            <meta property="og:description" content="340 likes: &quot;Compass video reel&quot;." />
          </head></html>`,
          { status: 200, headers: { 'Content-Type': 'text/html' } }
        );
      }
      return new Response('', { status: 404 });
    }) as typeof fetch;

    const sentMessages: Array<{ recipientId: string; text: string }> = [];
    const bot = new MetaInstagramBotService();
    Object.defineProperty(bot, 'isConfigured', { get: () => true });
    bot.sendDirectMessage = async (recipientId: string, text: string) => {
      sentMessages.push({ recipientId, text });
      return true;
    };

    // 1. Share a /p/ post and reply "5m" to set a reminder
    await bot.handleWebhookPayload({
      object: 'instagram',
      entry: [
        {
          messaging: [
            {
              sender: { id: 'sender_media_isolation' },
              message: { text: 'https://www.instagram.com/p/DS1goOmjhUi/' },
            },
          ],
        },
      ],
    });

    assert.strictEqual(sentMessages.length, 1);
    assert.ok(sentMessages[0].text.includes('🖼️ Added post to your Watch Later!'), `Got: ${sentMessages[0].text}`);

    const savedAfterPost = await Repository.getReels({ limit: 10 });
    assert.strictEqual(savedAfterPost.reels.length, 1);
    assert.strictEqual(savedAfterPost.reels[0].media_type, 'post');
    assert.strictEqual(savedAfterPost.reels[0].reel_url, 'https://www.instagram.com/p/DS1goOmjhUi/');

    await bot.handleWebhookPayload({
      object: 'instagram',
      entry: [
        {
          messaging: [
            {
              sender: { id: 'sender_media_isolation' },
              message: { text: '5m' },
            },
          ],
        },
      ],
    });
    assert.strictEqual(sentMessages.length, 2);
    assert.ok(sentMessages[1].text.includes('⏰ Reminder set for @the_political_compass:'), `Got: ${sentMessages[1].text}`);

    // 2. Make the reminder due and run ReminderWorker.checkDueReminders()
    const currentPost = (await Repository.getReels({ limit: 10 })).reels[0];
    await Repository.upsertSavedReel({
      ...currentPost,
      next_reminder_at: new Date(Date.now() - 1000).toISOString(),
    });
    const worker = new ReminderWorker();
    (worker as any).metaBot = bot;
    await worker.checkDueReminders();

    assert.strictEqual(sentMessages.length, 3);
    const reminderText = sentMessages[2].text;
    assert.ok(reminderText.includes('🖼️ @the_political_compass'), `Got: ${reminderText}`);
    assert.ok(reminderText.includes('👉 View Post: https://www.instagram.com/p/DS1goOmjhUi/'), `Got: ${reminderText}`);
    assert.ok(!reminderText.includes('/reel/DS1goOmjhUi/'), `Must never rewrite /p/ to /reel/: ${reminderText}`);
    const postUrlIdx = reminderText.indexOf('https://www.instagram.com/p/DS1goOmjhUi/');
    const profileUrlIdx = reminderText.indexOf('https://www.instagram.com/the_political_compass/');
    assert.ok(postUrlIdx > 0 && profileUrlIdx > postUrlIdx, 'Post URL must appear before creator profile URL');

    // 3. Mark watched and verify post-specific confirmation wording
    await bot.handleWebhookPayload({
      object: 'instagram',
      entry: [
        {
          messaging: [
            {
              sender: { id: 'sender_media_isolation' },
              message: { text: 'watched' },
            },
          ],
        },
      ],
    });

    assert.strictEqual(sentMessages.length, 4);
    assert.ok(sentMessages[3].text.includes("@the_political_compass's post"), `Got: ${sentMessages[3].text}`);

    // 4. Also save a /reel/ from the same creator so creator library has both Reels and Posts
    await bot.handleWebhookPayload({
      object: 'instagram',
      entry: [
        {
          messaging: [
            {
              sender: { id: 'sender_media_isolation' },
              message: { text: 'https://www.instagram.com/reel/DT_x3F4Dj3-/ 2h' },
            },
          ],
        },
      ],
    });

    // 5. Query bare username "the_political_compass" -> split Saved Library into Latest Reels & Latest Posts
    sentMessages.length = 0;
    await bot.handleWebhookPayload({
      object: 'instagram',
      entry: [
        {
          messaging: [
            {
              sender: { id: 'sender_media_isolation' },
              message: { text: 'the_political_compass' },
            },
          ],
        },
      ],
    });

    const combinedMixedReply = sentMessages.map((m) => m.text).join('\n---\n');
    assert.ok(combinedMixedReply.includes('📂 Saved Library'), `Expected split library header: ${combinedMixedReply}`);
    assert.ok(combinedMixedReply.includes('1 reel · 1 post'), `Expected split breakdown: ${combinedMixedReply}`);
    assert.ok(combinedMixedReply.includes('🎬 Saved Reel (1):'), `Expected Reels section: ${combinedMixedReply}`);
    assert.ok(combinedMixedReply.includes('🖼️ Saved Post (1):'), `Expected Posts section: ${combinedMixedReply}`);
    assert.ok(combinedMixedReply.includes('https://www.instagram.com/reel/DT_x3F4Dj3-/'));
    assert.ok(combinedMixedReply.includes('https://www.instagram.com/p/DS1goOmjhUi/'));
    assert.ok(!combinedMixedReply.includes('/reel/DS1goOmjhUi/'));

    // 6. Query "posts by @the_political_compass" -> returns ONLY Posts
    sentMessages.length = 0;
    await bot.handleWebhookPayload({
      object: 'instagram',
      entry: [
        {
          messaging: [
            {
              sender: { id: 'sender_media_isolation' },
              message: { text: 'posts by @the_political_compass' },
            },
          ],
        },
      ],
    });
    const postsOnlyReply = sentMessages.map((m) => m.text).join('\n---\n');
    assert.ok(postsOnlyReply.includes('🖼️ Saved Posts'), `Got: ${postsOnlyReply}`);
    assert.ok(postsOnlyReply.includes('https://www.instagram.com/p/DS1goOmjhUi/'));
    assert.ok(!postsOnlyReply.includes('DT_x3F4Dj3-'));

    // 7. Query "reels by @the_political_compass" -> returns ONLY Reels
    sentMessages.length = 0;
    await bot.handleWebhookPayload({
      object: 'instagram',
      entry: [
        {
          messaging: [
            {
              sender: { id: 'sender_media_isolation' },
              message: { text: 'reels by @the_political_compass' },
            },
          ],
        },
      ],
    });
    const reelsOnlyReply = sentMessages.map((m) => m.text).join('\n---\n');
    assert.ok(reelsOnlyReply.includes('🎬 Saved Reels'), `Got: ${reelsOnlyReply}`);
    assert.ok(reelsOnlyReply.includes('https://www.instagram.com/reel/DT_x3F4Dj3-/'));
    assert.ok(!reelsOnlyReply.includes('DS1goOmjhUi'));

    // 8. Cross-type 0-match hint when a creator has only reels and user asks for posts
    const reelOnlyCreator = await Repository.upsertCreator({
      instagram_user_id: 'creator_reel_only',
      username: 'reel_only_creator',
      display_name: 'Reel Only',
    });
    await Repository.upsertSavedReel({
      creator_id: reelOnlyCreator.id,
      shortcode: 'DReelOnly01',
      reel_url: 'https://www.instagram.com/reel/DReelOnly01/',
      instagram_sender_id: 'sender_media_isolation',
      media_type: 'reel',
      caption: 'Only a reel',
      thumbnail_url: null,
      saved_at: new Date().toISOString(),
    });

    sentMessages.length = 0;
    await bot.handleWebhookPayload({
      object: 'instagram',
      entry: [
        {
          messaging: [
            {
              sender: { id: 'sender_media_isolation' },
              message: { text: 'posts by @reel_only_creator' },
            },
          ],
        },
      ],
    });
    assert.strictEqual(sentMessages.length, 1);
    assert.ok(sentMessages[0].text.includes('No saved posts found for Creator: @reel_only_creator'));
    assert.ok(sentMessages[0].text.includes('They do have 1 saved reel — reply "reels by @reel_only_creator"'));

    Repository.resetMemoryStoreForTests();
  } finally {
    globalThis.fetch = originalFetch;
    if (prevUrl !== undefined) process.env.SUPABASE_URL = prevUrl;
    if (prevKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
  }
});

test('MetaInstagramBotService preserves recovered post classification on inconclusive legacy /reel/ resends while allowing conclusive updates', async () => {
  const prevUrl = process.env.SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  const originalFetch = globalThis.fetch;
  try {
    const { Repository } = await import('../src/db/repository.ts');
    Repository.resetMemoryStoreForTests();

    const creator = await Repository.upsertCreator({
      instagram_user_id: 'export_creator_compass',
      username: 'the_political_compass',
      display_name: 'The Political Compass',
    });

    // Recovered legacy post already repaired to media_type='post' & /p/ URL
    await Repository.upsertSavedReel({
      instagram_media_id: 'export_DS1goOmjhUi',
      shortcode: 'DS1goOmjhUi',
      reel_url: 'https://www.instagram.com/p/DS1goOmjhUi/',
      media_type: 'post',
      creator_id: creator.id,
      caption: 'Preserved quadrant post',
      thumbnail_url: 'https://scontent.cdninstagram.com/v/t51.2885-15/saved-post.jpg',
      taken_at: '2026-11-10T09:00:00Z',
      first_detected_at: '2026-11-10T09:00:00Z',
      save_order_rank: 1,
    });

    // Existing row whose metadata will conclusively classify it as CLIPS/reel
    await Repository.upsertSavedReel({
      instagram_media_id: 'export_DUpgradeReel',
      shortcode: 'DUpgradeReel',
      reel_url: 'https://www.instagram.com/p/DUpgradeReel/',
      media_type: 'post',
      creator_id: creator.id,
      caption: 'Upgraded clip item',
      taken_at: '2026-11-10T08:00:00Z',
      first_detected_at: '2026-11-10T08:00:00Z',
      save_order_rank: 2,
    });

    // Legacy misclassified row whose metadata conclusively identifies it as a /p/ post (and omits @handle)
    await Repository.upsertSavedReel({
      instagram_media_id: 'export_DRetroPost',
      shortcode: 'DRetroPost',
      reel_url: 'https://www.instagram.com/reel/DRetroPost/',
      media_type: 'reel',
      creator_id: creator.id,
      caption: 'Legacy misclassified post',
      taken_at: '2026-11-10T07:00:00Z',
      first_detected_at: '2026-11-10T07:00:00Z',
      save_order_rank: 3,
    });

    globalThis.fetch = (async (url: unknown) => {
      const target = String(url);
      if (target.includes('DUpgradeReel')) {
        return new Response(
          `<html><head>
            <meta property="og:url" content="https://www.instagram.com/the_political_compass/reel/DUpgradeReel/" />
            <meta property="og:title" content="The Political Compass (@the_political_compass) on Instagram" />
            <meta property="og:description" content="50 likes: &quot;Upgraded clip item&quot;." />
          </head></html>`,
          { status: 200, headers: { 'Content-Type': 'text/html' } }
        );
      }
      if (target.includes('DRetroPost')) {
        return new Response(
          `<html><head>
            <meta property="og:url" content="https://www.instagram.com/the_political_compass/p/DRetroPost/" />
            <meta property="og:title" content="The Political Compass on Instagram: &quot;Retro post&quot;" />
          </head></html>`,
          { status: 200, headers: { 'Content-Type': 'text/html' } }
        );
      }
      // Inconclusive / empty response simulating rate-limited or login-walled Instagram fetch
      return new Response('', { status: 404 });
    }) as typeof fetch;

    const sentMessages: Array<{ recipientId: string; text: string }> = [];
    const bot = new MetaInstagramBotService();
    bot.sendDirectMessage = async (recipientId: string, text: string) => {
      sentMessages.push({ recipientId, text });
      return true;
    };

    // 1. Resend legacy /reel/ URL for DS1goOmjhUi when metadata is unavailable
    await bot.handleWebhookPayload({
      object: 'instagram',
      entry: [
        {
          messaging: [
            {
              sender: { id: 'sender_preserve' },
              message: { text: 'https://www.instagram.com/reel/DS1goOmjhUi/ 30m' },
            },
          ],
        },
      ],
    });

    assert.strictEqual(sentMessages.length, 1);
    assert.ok(sentMessages[0].text.includes('🖼️ Added post to your Watch Later!'), `Got: ${sentMessages[0].text}`);
    assert.ok(sentMessages[0].text.includes('Creator: @the_political_compass'), `Got: ${sentMessages[0].text}`);

    const preserved = await Repository.getSavedItemByShortcode('DS1goOmjhUi', 'sender_preserve');
    assert.ok(preserved);
    assert.strictEqual(preserved.media_type, 'post');
    assert.strictEqual(preserved.reel_url, 'https://www.instagram.com/p/DS1goOmjhUi/');
    assert.strictEqual(preserved.instagram_media_id, 'dm_sender_preserve_DS1goOmjhUi');
    assert.strictEqual(preserved.caption, 'Preserved quadrant post');

    // Original unattributed archive row must remain completely intact
    const originalArchivePost = await Repository.getSavedItemByShortcode('DS1goOmjhUi', null);
    assert.ok(originalArchivePost);
    assert.strictEqual(originalArchivePost.instagram_media_id, 'export_DS1goOmjhUi');
    assert.strictEqual(originalArchivePost.taken_at, '2026-11-10T09:00:00Z');
    assert.strictEqual(originalArchivePost.first_detected_at, '2026-11-10T09:00:00Z');

    const postFiltered = await Repository.getReels({ mediaType: 'post', limit: 10 });
    assert.strictEqual(postFiltered.reels.some((r) => r.shortcode === 'DS1goOmjhUi'), true);

    // 2. Resend /reel/ URL for DUpgradeReel when metadata conclusively identifies CLIPS
    await bot.handleWebhookPayload({
      object: 'instagram',
      entry: [
        {
          messaging: [
            {
              sender: { id: 'sender_preserve' },
              message: { text: 'https://www.instagram.com/reel/DUpgradeReel/ 30m' },
            },
          ],
        },
      ],
    });

    assert.strictEqual(sentMessages.length, 2);
    assert.ok(sentMessages[1].text.includes('🎬 Added to your Watch Later!'), `Got: ${sentMessages[1].text}`);

    const upgraded = await Repository.getSavedItemByShortcode('DUpgradeReel', 'sender_preserve');
    assert.ok(upgraded);
    assert.strictEqual(upgraded.media_type, 'reel');
    assert.strictEqual(upgraded.reel_url, 'https://www.instagram.com/reel/DUpgradeReel/');

    // 3. Resend legacy /reel/ URL for DRetroPost when metadata conclusively resolves /p/ without @handle
    await bot.handleWebhookPayload({
      object: 'instagram',
      entry: [
        {
          messaging: [
            {
              sender: { id: 'sender_preserve' },
              message: { text: 'https://www.instagram.com/reel/DRetroPost/ 30m' },
            },
          ],
        },
      ],
    });

    assert.strictEqual(sentMessages.length, 3);
    assert.ok(sentMessages[2].text.includes('🖼️ Added post to your Watch Later!'), `Got: ${sentMessages[2].text}`);
    assert.ok(sentMessages[2].text.includes('Creator: @the_political_compass'), `Got: ${sentMessages[2].text}`);

    const retroFixed = await Repository.getSavedItemByShortcode('DRetroPost', 'sender_preserve');
    assert.ok(retroFixed);
    assert.strictEqual(retroFixed.media_type, 'post');
    assert.strictEqual(retroFixed.reel_url, 'https://www.instagram.com/p/DRetroPost/');
    assert.strictEqual(retroFixed.creator?.username, 'the_political_compass');

    // 4. New unknown /reel/ link with unavailable metadata still defaults to reel
    await bot.handleWebhookPayload({
      object: 'instagram',
      entry: [
        {
          messaging: [
            {
              sender: { id: 'sender_preserve' },
              message: { text: 'https://www.instagram.com/reel/DBrandNewReel/ 30m' },
            },
          ],
        },
      ],
    });

    assert.strictEqual(sentMessages.length, 4);
    assert.ok(sentMessages[3].text.includes('🎬 Added to your Watch Later!'), `Got: ${sentMessages[3].text}`);
    const freshReel = await Repository.getSavedItemByShortcode('DBrandNewReel', 'sender_preserve');
    assert.ok(freshReel);
    assert.strictEqual(freshReel.media_type, 'reel');
    assert.strictEqual(freshReel.reel_url, 'https://www.instagram.com/reel/DBrandNewReel/');

    Repository.resetMemoryStoreForTests();
  } finally {
    globalThis.fetch = originalFetch;
    if (prevUrl !== undefined) process.env.SUPABASE_URL = prevUrl;
    if (prevKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
  }
});

test('Repository.getSavedItemByShortcode throws on Supabase query errors so MetaInstagramBotService fails closed per-event while continuing batch processing', async () => {
  const prevUrl = process.env.SUPABASE_URL;
  const prevServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const prevAnonKey = process.env.SUPABASE_ANON_KEY;
  const originalFetch = globalThis.fetch;

  const { resetSupabaseClientForTests } = await import('../src/db/client.ts');
  const { Repository } = await import('../src/db/repository.ts');

  try {
    resetSupabaseClientForTests();
    process.env.SUPABASE_URL = 'https://mock-reeler-test.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock-service-role-key';
    delete process.env.SUPABASE_ANON_KEY;

    const failedShortcodes = new Set(['DS1goOmjhUi', 'DFailChange1']);
    const savedWrites: string[] = [];
    let mode: 'error' | 'empty' = 'error';

    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      if (target.startsWith('https://mock-reeler-test.supabase.co/rest/v1/')) {
        const method = (init?.method || 'GET').toUpperCase();
        const bodyText = typeof init?.body === 'string' ? init.body : '';

        if (method === 'GET' && target.includes('/saved_reels?')) {
          if (mode === 'error') {
            for (const failCode of failedShortcodes) {
              if (target.includes(failCode)) {
                return new Response(
                  JSON.stringify({ code: 'XX000', message: 'connection terminated unexpectedly' }),
                  { status: 500, headers: { 'Content-Type': 'application/json' } }
                );
              }
            }
          }
          return new Response(JSON.stringify(null), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        if (target.includes('/creators')) {
          if (method === 'POST') {
            return new Response(
              JSON.stringify({
                id: 'creator_mock_1',
                instagram_user_id: 'creator_unattributed',
                username: 'Instagram Creator',
                display_name: 'Instagram Creator',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              }),
              { status: 201, headers: { 'Content-Type': 'application/json' } }
            );
          }
          return new Response(JSON.stringify([]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        if (method !== 'GET' && target.includes('/saved_reels')) {
          savedWrites.push(bodyText);
          let parsed: any = {};
          try {
            parsed = JSON.parse(bodyText);
          } catch {}
          return new Response(
            JSON.stringify({
              id: `reel_${parsed.shortcode || 'ok'}`,
              ...parsed,
              creator: { id: 'creator_mock_1', username: 'Instagram Creator', display_name: 'Instagram Creator' },
            }),
            { status: 201, headers: { 'Content-Type': 'application/json' } }
          );
        }

        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // Inconclusive Instagram metadata fetch
      return new Response('', { status: 404 });
    }) as typeof fetch;

    await assert.rejects(
      () => Repository.getSavedItemByShortcode('DS1goOmjhUi'),
      /Failed to look up saved item DS1goOmjhUi: connection terminated unexpectedly/
    );

    const sentMessages: Array<{ recipientId: string; text: string }> = [];
    const bot = new MetaInstagramBotService();
    bot.sendDirectMessage = async (recipientId: string, text: string) => {
      sentMessages.push({ recipientId, text });
      return true;
    };

    // Failing items in both `messaging` and `changes` must fail closed while later items in each batch still process
    await bot.handleWebhookPayload({
      object: 'instagram',
      entry: [
        {
          messaging: [
            {
              sender: { id: 'sender_supabase_error' },
              message: { text: 'https://www.instagram.com/reel/DS1goOmjhUi/ 30m' },
            },
            {
              sender: { id: 'sender_batch_ok' },
              message: { text: 'https://www.instagram.com/reel/DBatchOk1/ 30m' },
            },
          ],
          changes: [
            {
              field: 'messages',
              value: {
                sender: { id: 'sender_change_error' },
                message: { text: 'https://www.instagram.com/reel/DFailChange1/ 30m' },
              },
            },
            {
              field: 'messages',
              value: {
                sender: { id: 'sender_change_ok' },
                message: { text: 'https://www.instagram.com/p/DChangeOk1/ 20m' },
              },
            },
          ],
        },
      ],
    });

    assert.strictEqual(
      savedWrites.some((w) => w.includes('DS1goOmjhUi') || w.includes('DFailChange1')),
      false,
      'Failed lookups must fail closed without writing to Supabase'
    );
    assert.strictEqual(
      savedWrites.some((w) => w.includes('DBatchOk1')),
      true,
      'Subsequent messaging event after a failure must still be saved'
    );
    assert.strictEqual(
      savedWrites.some((w) => w.includes('DChangeOk1')),
      true,
      'Subsequent change event after a failure must still be saved'
    );
    assert.deepStrictEqual(
      sentMessages.map((m) => m.recipientId),
      ['sender_batch_ok', 'sender_change_ok'],
      'Only successfully processed events receive confirmation DMs'
    );

    mode = 'empty';
    const missing = await Repository.getSavedItemByShortcode('DMissingShortcode');
    assert.strictEqual(missing, null);
  } finally {
    resetSupabaseClientForTests();
    globalThis.fetch = originalFetch;
    if (prevUrl !== undefined) process.env.SUPABASE_URL = prevUrl;
    else delete process.env.SUPABASE_URL;
    if (prevServiceKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = prevServiceKey;
    else delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (prevAnonKey !== undefined) process.env.SUPABASE_ANON_KEY = prevAnonKey;
    else delete process.env.SUPABASE_ANON_KEY;
  }
});

test('ReminderWorker.pollInboundDMs bounds failed admin DM retries, ignores bot replies without tracking, and prunes stale IDs', async () => {
  const prevAdminUsername = process.env.ADMIN_USERNAME;
  const prevIgUserId = process.env.INSTAGRAM_USER_ID;

  try {
    process.env.ADMIN_USERNAME = 'admin_tester';
    process.env.INSTAGRAM_USER_ID = 'bot_user_999';

    const { ReminderWorker } = await import('../src/services/reminderWorker.ts');
    const worker = new ReminderWorker();
    const internal = worker as any;
    internal.adminThreadId = 'thread_1';
    internal.adminUserId = 'admin_1';

    let currentMessages = [
      { itemId: 'bot_msg_1', userId: 'bot_user_999', timestamp: 1, itemType: 'text', text: 'bot echo' },
      { itemId: 'transient_msg', userId: 'admin_1', timestamp: 2, itemType: 'text', text: 'transient' },
      { itemId: 'perm_fail_msg', userId: 'admin_1', timestamp: 3, itemType: 'text', text: 'broken' },
    ];

    internal.actionClient = {
      getThreadMessages: async () => ({ success: true, data: currentMessages }),
    };

    const callCounts = new Map<string, number>();
    let transientShouldFail = true;

    internal.handleAdminMessage = async (msg: { itemId: string }) => {
      callCounts.set(msg.itemId, (callCounts.get(msg.itemId) ?? 0) + 1);
      if (msg.itemId === 'perm_fail_msg') {
        throw new Error('permanent error');
      }
      if (msg.itemId === 'transient_msg' && transientShouldFail) {
        throw new Error('transient error');
      }
    };

    // Poll 1: transient fails (1), perm fails (1), bot reply ignored without being tracked
    await worker.pollInboundDMs();
    assert.strictEqual(callCounts.get('bot_msg_1'), undefined);
    assert.strictEqual(internal.processedItemIds.has('bot_msg_1'), false);
    assert.strictEqual(internal.failedItemAttempts.get('transient_msg'), 1);
    assert.strictEqual(internal.failedItemAttempts.get('perm_fail_msg'), 1);

    // Poll 2: transient succeeds and clears failures; perm fails (2)
    transientShouldFail = false;
    await worker.pollInboundDMs();
    assert.strictEqual(callCounts.get('transient_msg'), 2);
    assert.strictEqual(internal.processedItemIds.has('transient_msg'), true);
    assert.strictEqual(internal.failedItemAttempts.has('transient_msg'), false);
    assert.strictEqual(internal.failedItemAttempts.get('perm_fail_msg'), 2);

    // Poll 3: transient skipped; perm fails attempt 3 -> marked processed & removed from failure map
    await worker.pollInboundDMs();
    assert.strictEqual(callCounts.get('transient_msg'), 2);
    assert.strictEqual(callCounts.get('perm_fail_msg'), 3);
    assert.strictEqual(internal.processedItemIds.has('perm_fail_msg'), true);
    assert.strictEqual(internal.failedItemAttempts.has('perm_fail_msg'), false);

    // Poll 4: permanent failure is not retried again
    await worker.pollInboundDMs();
    assert.strictEqual(callCounts.get('perm_fail_msg'), 3);

    // Poll 5: stale IDs outside latest window are pruned, keeping processedItemIds bounded
    currentMessages = [
      { itemId: 'fresh_msg', userId: 'admin_1', timestamp: 4, itemType: 'text', text: 'fresh' },
    ];
    await worker.pollInboundDMs();
    assert.strictEqual(internal.processedItemIds.has('transient_msg'), false);
    assert.strictEqual(internal.processedItemIds.has('perm_fail_msg'), false);
    assert.strictEqual(internal.processedItemIds.has('fresh_msg'), true);
    assert.strictEqual(internal.processedItemIds.size, 1);

    // Bounded capacity safeguard even if active thread payload exceeds 1000 items
    const largeBatch = Array.from({ length: 1005 }, (_, i) => ({
      itemId: `bulk_${i}`,
      userId: 'admin_1',
      timestamp: 100 + i,
      itemType: 'text',
      text: `msg ${i}`,
    }));
    currentMessages = largeBatch;
    await worker.pollInboundDMs();
    assert.ok(internal.processedItemIds.size <= 1000, `Expected <= 1000, got ${internal.processedItemIds.size}`);
  } finally {
    if (prevAdminUsername !== undefined) process.env.ADMIN_USERNAME = prevAdminUsername;
    else delete process.env.ADMIN_USERNAME;
    if (prevIgUserId !== undefined) process.env.INSTAGRAM_USER_ID = prevIgUserId;
    else delete process.env.INSTAGRAM_USER_ID;
  }
});

test('MetaInstagramBotService marks new DM shares as bot-sent (is_saved_on_instagram=false, saved_at=null) while preserving IG-saved items', async () => {
  const prevUrl = process.env.SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  const originalFetch = globalThis.fetch;
  try {
    const { Repository, resolveEffectiveSavedAt } = await import('../src/db/repository.ts');
    Repository.resetMemoryStoreForTests();

    const creator = await Repository.upsertCreator({
      instagram_user_id: 'creator_dm_saved_at',
      username: 'saved_date_creator',
      display_name: 'Saved Date Creator',
    });

    await Repository.upsertSavedReel({
      instagram_media_id: '4023660617817200517_76670992220',
      shortcode: 'DSyncedNoDate',
      reel_url: 'https://www.instagram.com/reel/DSyncedNoDate/',
      media_type: 'reel',
      creator_id: creator.id,
      caption: 'Synced item without saved_at',
      taken_at: '2026-11-05T11:22:28Z',
      saved_at: null,
      first_detected_at: '2026-11-06T14:45:00Z',
      save_order_rank: 1,
      is_saved_on_instagram: true,
    });

    globalThis.fetch = (async () =>
      new Response(
        `<html><head>
          <meta property="og:url" content="https://www.instagram.com/saved_date_creator/reel/DFreshDmSave/" />
          <meta property="og:title" content="Saved Date Creator (@saved_date_creator) on Instagram" />
          <meta property="og:description" content="10 likes: &quot;Fresh DM&quot;." />
        </head></html>`,
        { status: 200, headers: { 'Content-Type': 'text/html' } }
      )) as typeof fetch;

    const dmReplies: string[] = [];
    const bot = new MetaInstagramBotService();
    Object.defineProperty(bot, 'isConfigured', { get: () => true });
    bot.sendDirectMessage = async (_recipientId: string, text: string) => {
      dmReplies.push(text);
      return true;
    };

    await bot.handleWebhookPayload({
      object: 'instagram',
      entry: [
        {
          messaging: [
            { sender: { id: 'sender_dm_date' }, message: { text: 'https://www.instagram.com/reel/DFreshDmSave/ 2h' } },
            { sender: { id: 'sender_dm_date' }, message: { text: 'https://www.instagram.com/reel/DSyncedNoDate/ 2h' } },
          ],
        },
      ],
    });

    const freshItem = await Repository.getSavedItemByShortcode('DFreshDmSave');
    assert.ok(freshItem, 'Fresh DM item must be tracked in repository');
    assert.strictEqual(freshItem.is_saved_on_instagram, false, 'Brand-new DM webhook item belongs to Sent to Bot, not Saved on IG');
    assert.strictEqual(freshItem.saved_at, null, 'Brand-new DM item must leave archive saved_at null until imported from saved_posts.json');
    assert.ok(resolveEffectiveSavedAt(freshItem), 'Effective timestamp must fall back to first_detected_at for sorting and filters');
    assert.ok(dmReplies[0]?.includes('Added to your Watch Later!'), `Expected honest Watch Later reply, got: ${dmReplies[0]}`);
    assert.ok(!/instagram saved/i.test(dmReplies[0] || ''), `Must not claim IG Saved bookmark for DM webhook: ${dmReplies[0]}`);

    const syncedItem = await Repository.getSavedItemByShortcode('DSyncedNoDate');
    assert.strictEqual(syncedItem?.is_saved_on_instagram, true, 'Existing IG-saved item must remain Saved on IG when shared via DM');
    assert.strictEqual(syncedItem?.saved_at, null, 'Existing synced item must preserve null saved_at for future archive backfill');

    // Verify ReminderWorker honesty: saveMedia=false keeps is_saved_on_instagram=false; saveMedia=true promotes cleanly
    const { ReminderWorker } = await import('../src/services/reminderWorker.ts');
    const worker = new ReminderWorker();
    const workerAny = worker as any;
    const workerMessages: string[] = [];
    let shouldNativeSaveSucceed = false;
    workerAny.actionClient = {
      saveMedia: async () => ({ success: shouldNativeSaveSucceed, data: shouldNativeSaveSucceed }),
      sendDirectMessage: async (_uid: string, text: string) => {
        workerMessages.push(text);
        return true;
      },
    };
    workerAny.adminUserId = 'admin_1';

    await Repository.upsertSavedReel({
      instagram_media_id: '18084562202349999',
      shortcode: 'DArchivedWorker',
      reel_url: 'https://www.instagram.com/reel/DArchivedWorker/',
      media_type: 'reel',
      creator_id: creator.id,
      caption: 'Archived in 2024',
      taken_at: '2024-05-01T10:00:00.000Z',
      saved_at: '2024-05-02T12:00:00.000Z',
      first_detected_at: '2024-05-02T12:00:00.000Z',
      save_order_rank: 42,
      is_saved_on_instagram: true,
    });

    await workerAny.handleAdminMessage({
      itemId: 'rich_archive_msg',
      userId: 'admin_1',
      timestamp: Date.now(),
      itemType: 'reel_share',
      reel: {
        mediaId: '999999999999',
        shortcode: 'DArchivedWorker',
        authorUsername: 'saved_date_creator',
        caption: 'Archived in 2024',
        thumbnailUrl: null,
        mediaType: 'reel',
        reelUrl: 'https://www.instagram.com/reel/DArchivedWorker/',
      },
    });

    const afterWorker = await Repository.getSavedItemByShortcode('DArchivedWorker');
    assert.strictEqual(afterWorker?.saved_at, '2024-05-02T12:00:00.000Z', 'Worker must preserve original archive saved_at even when mediaId is present');
    assert.strictEqual(afterWorker?.instagram_media_id, '18084562202349999', 'Worker must preserve existing instagram_media_id');
    assert.strictEqual(afterWorker?.is_saved_on_instagram, true, 'Worker must preserve IG-saved membership');

    // New item through ReminderWorker when saveMedia fails -> Sent to Bot + honest reply without Instagram Saved claim
    await workerAny.handleAdminMessage({
      itemId: 'rich_worker_nosave',
      userId: 'admin_1',
      timestamp: Date.now(),
      itemType: 'reel_share',
      reel: {
        mediaId: '888888888881',
        shortcode: 'DBotWorkerNoSave',
        authorUsername: 'saved_date_creator',
        caption: 'Bot worker unsaved',
        thumbnailUrl: null,
        mediaType: 'reel',
        reelUrl: 'https://www.instagram.com/reel/DBotWorkerNoSave/',
      },
    });

    const workerUnsaved = await Repository.getSavedItemByShortcode('DBotWorkerNoSave');
    assert.strictEqual(workerUnsaved?.is_saved_on_instagram, false);
    assert.strictEqual(workerUnsaved?.saved_at, null);
    assert.ok(workerMessages[1]?.includes('🎬 Added to your Watch Later!'), `Got: ${workerMessages[1]}`);
    assert.ok(!workerMessages[1]?.includes('bookmarked to your Instagram Saved'), `Must not lie when saveMedia failed: ${workerMessages[1]}`);

    // New item through ReminderWorker when saveMedia succeeds -> Saved on IG + saved_at + bookmark confirmation
    shouldNativeSaveSucceed = true;
    await workerAny.handleAdminMessage({
      itemId: 'rich_worker_saved',
      userId: 'admin_1',
      timestamp: Date.now(),
      itemType: 'reel_share',
      reel: {
        mediaId: '888888888882',
        shortcode: 'DIgSavedWorker',
        authorUsername: 'saved_date_creator',
        caption: 'Native IG save succeeded',
        thumbnailUrl: null,
        mediaType: 'post',
        reelUrl: 'https://www.instagram.com/p/DIgSavedWorker/',
      },
    });

    const workerSaved = await Repository.getSavedItemByShortcode('DIgSavedWorker');
    assert.strictEqual(workerSaved?.is_saved_on_instagram, true);
    assert.ok(workerSaved?.saved_at, 'Successful native IG save must record saved_at');
    assert.ok(workerMessages[2]?.includes('bookmarked to your Instagram Saved!'), `Got: ${workerMessages[2]}`);

    Repository.resetMemoryStoreForTests();
  } finally {
    globalThis.fetch = originalFetch;
    if (prevUrl !== undefined) process.env.SUPABASE_URL = prevUrl;
    if (prevKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
  }
});

test('Sent to Bot items preserve full Watch Later, Reminder, Watched parity & honest DM copy', async () => {
  const prevUrl = process.env.SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  const originalFetch = globalThis.fetch;
  try {
    const { Repository } = await import('../src/db/repository.ts');
    const { ReminderWorker } = await import('../src/services/reminderWorker.ts');
    const { formatHumanReelLabel, formatWatchLaterReminderMessage } = await import('../src/utils/reelMessages.ts');
    Repository.resetMemoryStoreForTests();

    // Unit check DM wording honesty when is_saved_on_instagram === false vs true
    assert.strictEqual(
      formatHumanReelLabel({ caption: null, creator: null, media_type: 'reel', reel_url: 'https://www.instagram.com/reel/X1/', is_saved_on_instagram: false }),
      'that reel'
    );
    assert.strictEqual(
      formatHumanReelLabel({ caption: null, creator: null, media_type: 'post', reel_url: 'https://www.instagram.com/p/X2/', is_saved_on_instagram: true }),
      'your saved post'
    );

    const botReminderHeader = formatWatchLaterReminderMessage({
      reel_url: 'https://www.instagram.com/p/X3/',
      caption: null,
      creator: null,
      media_type: 'post',
      is_saved_on_instagram: false,
    });
    assert.ok(botReminderHeader.includes('🖼️ Watch Later Post'), `Got: ${botReminderHeader}`);
    assert.ok(!botReminderHeader.includes('Saved Post'), `Must not label bot-only item as Saved Post: ${botReminderHeader}`);

    globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch;

    const sentMessages: string[] = [];
    const bot = new MetaInstagramBotService();
    Object.defineProperty(bot, 'isConfigured', { get: () => true });
    bot.sendDirectMessage = async (_recipientId: string, text: string) => {
      sentMessages.push(text);
      return true;
    };

    // Share a bot-only post with reminder schedule via webhook
    await bot.handleWebhookPayload({
      object: 'instagram',
      entry: [
        {
          messaging: [
            { sender: { id: 'sender_bot_parity' }, message: { text: 'https://www.instagram.com/p/DBotParity1/?igsh=testToken123 30m' } },
          ],
        },
      ],
    });

    const botItem = await Repository.getSavedItemByShortcode('DBotParity1');
    assert.ok(botItem);
    assert.strictEqual(botItem.is_saved_on_instagram, false);
    assert.strictEqual(botItem.watch_status, 'watch_later');
    assert.ok(botItem.next_reminder_at);

    // Due reminder dispatches cleanly for bot item
    await Repository.updateReminderSchedule(botItem.id, new Date(Date.now() - 1000).toISOString(), 1800);
    const worker = new ReminderWorker();
    (worker as any).metaBot = bot;
    await worker.checkDueReminders();

    assert.strictEqual(sentMessages.length, 2);
    assert.ok(sentMessages[1].includes('🔔 Watch Later Reminder!'));
    assert.ok(sentMessages[1].includes('https://www.instagram.com/p/DBotParity1/'));

    // Replying "watched" marks the bot item watched while staying in Sent to Bot category
    await bot.handleWebhookPayload({
      object: 'instagram',
      entry: [
        {
          messaging: [
            { sender: { id: 'sender_bot_parity' }, message: { text: 'watched' } },
          ],
        },
      ],
    });

    const afterWatched = await Repository.getSavedItemByShortcode('DBotParity1');
    assert.strictEqual(afterWatched?.watch_status, 'watched');
    assert.strictEqual(afterWatched?.is_saved_on_instagram, false);
    assert.strictEqual(afterWatched?.next_reminder_at, null);
    assert.ok(sentMessages[2]?.includes('that post'), `Expected honest "that post" label, got: ${sentMessages[2]}`);
    assert.ok(!/saved post/i.test(sentMessages[2] || ''), `Got: ${sentMessages[2]}`);

    // Monotonic source ownership: stale bot write after archive promotion never demotes true -> false or wipes saved_at
    const raceCreator = await Repository.upsertCreator({
      instagram_user_id: 'ig_race_creator',
      username: 'race_creator',
      display_name: 'Race Creator',
    });
    const archiveSavedIso = '2026-11-08T10:00:00.000Z';
    await Repository.upsertSavedReel({
      instagram_media_id: 'shortcode_DMonoRace1',
      shortcode: 'DMonoRace1',
      reel_url: 'https://www.instagram.com/reel/DMonoRace1/',
      media_type: 'reel',
      creator_id: raceCreator.id,
      caption: 'archive promoted mid-flight',
      thumbnail_url: null,
      taken_at: '2026-11-07T08:00:00.000Z',
      saved_at: archiveSavedIso,
      first_detected_at: archiveSavedIso,
      save_order_rank: 1,
      is_saved_on_instagram: true,
    });
    const afterStaleBotWrite = await Repository.upsertSavedReel({
      instagram_media_id: 'shortcode_DMonoRace1',
      shortcode: 'DMonoRace1',
      reel_url: 'https://www.instagram.com/reel/DMonoRace1/',
      media_type: 'reel',
      creator_id: raceCreator.id,
      caption: 'archive promoted mid-flight',
      thumbnail_url: null,
      taken_at: archiveSavedIso,
      saved_at: null,
      first_detected_at: new Date().toISOString(),
      save_order_rank: 1,
      watch_status: 'watch_later',
      reminder_interval_seconds: 1800,
      next_reminder_at: new Date(Date.now() + 1800 * 1000).toISOString(),
      is_saved_on_instagram: false,
      instagram_sender_id: 'sender_bot_parity',
    });
    assert.strictEqual(afterStaleBotWrite?.is_saved_on_instagram, true, 'Stale bot write must never demote IG-saved item');
    assert.strictEqual(afterStaleBotWrite?.saved_at, archiveSavedIso, 'Stale bot write must preserve archive saved_at');
    assert.strictEqual(afterStaleBotWrite?.watch_status, 'watch_later', 'Scheduling fields still update cleanly');

    Repository.resetMemoryStoreForTests();
  } finally {
    globalThis.fetch = originalFetch;
    if (prevUrl !== undefined) process.env.SUPABASE_URL = prevUrl;
    if (prevKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
  }
});

test('MetaInstagramBotService and Repository preserve existing sender Watch Later reminder when a conflicting sender shares the same item (sequential and concurrent Supabase guard)', async () => {
  const prevUrl = process.env.SUPABASE_URL;
  const prevServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const prevAnonKey = process.env.SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_ANON_KEY;

  const originalFetch = globalThis.fetch;
  const { resetSupabaseClientForTests } = await import('../src/db/client.ts');
  const { Repository, SenderReminderConflictError } = await import('../src/db/repository.ts');
  try {
    Repository.resetMemoryStoreForTests();

    globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch;

    const sentMessages: Array<{ recipientId: string; text: string }> = [];
    const bot = new MetaInstagramBotService();
    bot.sendDirectMessage = async (recipientId: string, text: string) => {
      sentMessages.push({ recipientId, text });
      return true;
    };

    // 1. Sender A adds a reel with a 30m custom reminder and a post awaiting choice (10m prompt)
    await bot.handleWebhookPayload({
      object: 'instagram',
      entry: [
        {
          messaging: [
            { sender: { id: 'sender_alpha' }, message: { text: 'https://www.instagram.com/reel/DConflictReel1/ 30m' } },
            { sender: { id: 'sender_alpha' }, message: { text: 'https://www.instagram.com/p/DConflictPost1/' } },
          ],
        },
      ],
    });

    const reelBefore = await Repository.getSavedItemByShortcode('DConflictReel1', 'sender_alpha');
    const postBefore = await Repository.getSavedItemByShortcode('DConflictPost1', 'sender_alpha');
    assert.strictEqual(reelBefore?.instagram_sender_id, 'sender_alpha');
    assert.strictEqual(postBefore?.instagram_sender_id, 'sender_alpha');
    assert.ok(reelBefore?.next_reminder_at);
    assert.ok(postBefore?.awaiting_reminder_choice_until);

    sentMessages.length = 0;

    // 2. Sender B shares the exact same items with different schedules -> gets isolated per-sender rows without collision
    await bot.handleWebhookPayload({
      object: 'instagram',
      entry: [
        {
          messaging: [
            { sender: { id: 'sender_beta' }, message: { text: 'https://www.instagram.com/reel/DConflictReel1/ 2h' } },
            { sender: { id: 'sender_beta' }, message: { text: 'https://www.instagram.com/p/DConflictPost1/' } },
          ],
        },
      ],
    });

    assert.strictEqual(sentMessages.length, 2);
    assert.strictEqual(sentMessages[0].recipientId, 'sender_beta');
    assert.ok(sentMessages[0].text.includes('Added to your Watch Later'));
    assert.ok(!sentMessages[0].text.includes('DConflictReel1'));

    assert.strictEqual(sentMessages[1].recipientId, 'sender_beta');
    assert.ok(sentMessages[1].text.includes('Added post to your Watch Later'));
    assert.ok(!sentMessages[1].text.includes('DConflictPost1'));

    // Sender A's schedule & ownership remain completely untouched
    const reelAfter = await Repository.getSavedItemByShortcode('DConflictReel1', 'sender_alpha');
    const postAfter = await Repository.getSavedItemByShortcode('DConflictPost1', 'sender_alpha');
    assert.strictEqual(reelAfter?.instagram_sender_id, 'sender_alpha');
    assert.strictEqual(reelAfter?.next_reminder_at, reelBefore?.next_reminder_at);
    assert.strictEqual(reelAfter?.reminder_interval_seconds, reelBefore?.reminder_interval_seconds);
    assert.strictEqual(postAfter?.instagram_sender_id, 'sender_alpha');
    assert.strictEqual(postAfter?.awaiting_reminder_choice_until, postBefore?.awaiting_reminder_choice_until);

    // Sender B has independent rows with its own schedule
    const betaReel = await Repository.getSavedItemByShortcode('DConflictReel1', 'sender_beta');
    const betaPost = await Repository.getSavedItemByShortcode('DConflictPost1', 'sender_beta');
    assert.strictEqual(betaReel?.instagram_sender_id, 'sender_beta');
    assert.strictEqual(betaReel?.reminder_interval_seconds, 7200);
    assert.notStrictEqual(betaReel?.id, reelAfter?.id);
    assert.strictEqual(betaPost?.instagram_sender_id, 'sender_beta');
    assert.notStrictEqual(betaPost?.id, postAfter?.id);

    // Same sender resending updates only their own schedule cleanly
    sentMessages.length = 0;
    await bot.handleWebhookPayload({
      object: 'instagram',
      entry: [
        {
          messaging: [
            { sender: { id: 'sender_alpha' }, message: { text: 'https://www.instagram.com/reel/DConflictReel1/ 45m' } },
          ],
        },
      ],
    });
    assert.ok(sentMessages[0]?.text.includes('Added to your Watch Later!'));
    const reelRescheduled = await Repository.getSavedItemByShortcode('DConflictReel1', 'sender_alpha');
    assert.strictEqual(reelRescheduled?.reminder_interval_seconds, 2700);
    assert.strictEqual((await Repository.getSavedItemByShortcode('DConflictReel1', 'sender_beta'))?.reminder_interval_seconds, 7200);

    // Sender A stopping all reminders does NOT cancel Sender B's active reminder
    await bot.handleWebhookPayload({
      object: 'instagram',
      entry: [
        {
          messaging: [
            { sender: { id: 'sender_alpha' }, message: { text: 'stop all' } },
          ],
        },
      ],
    });
    const alphaAfterStop = await Repository.getSavedItemByShortcode('DConflictReel1', 'sender_alpha');
    const betaAfterAlphaStop = await Repository.getSavedItemByShortcode('DConflictReel1', 'sender_beta');
    assert.strictEqual(alphaAfterStop?.watch_status, 'watched');
    assert.strictEqual(betaAfterAlphaStop?.watch_status, 'watch_later');
    assert.strictEqual(betaAfterAlphaStop?.reminder_interval_seconds, 7200);

    Repository.resetMemoryStoreForTests();

    // 3. Concurrent TOCTOU race in Supabase path: atomic .or() guard rejects conflicting sender without confirmation
    resetSupabaseClientForTests();
    process.env.SUPABASE_URL = 'https://mock-reeler-test.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock-service-role-key';

    let rowGetCount = 0;
    let sawAtomicGuardOrFilter = false;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      if (target.startsWith('https://mock-reeler-test.supabase.co/rest/v1/')) {
        const method = (init?.method || 'GET').toUpperCase();
        if (target.includes('/creators')) {
          return new Response(
            JSON.stringify({
              id: 'creator_race_1',
              instagram_user_id: 'creator_unattributed_DRaceConflict1',
              username: 'Instagram Creator',
              display_name: 'Instagram Creator',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }),
            { status: 201, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (target.includes('/saved_reels')) {
          // 1) insert(ignoreDuplicates=true) returns empty -> conflict exists
          if (method === 'POST') {
            return new Response(JSON.stringify(null), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          // 2) Initial lookups see unattributed 'unwatched', final ownership check after guarded PATCH sees sender_alpha active
          if (method === 'GET') {
            rowGetCount++;
            if (rowGetCount <= 2) {
              return new Response(
                JSON.stringify({
                  id: 'uuid_race_1',
                  instagram_media_id: 'export_race_1',
                  shortcode: 'DRaceConflict1',
                  reel_url: 'https://www.instagram.com/reel/DRaceConflict1/',
                  media_type: 'reel',
                  creator_id: 'creator_race_1',
                  watch_status: 'unwatched',
                  instagram_sender_id: null,
                  is_saved_on_instagram: true,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
              );
            }
            return new Response(
              JSON.stringify({
                id: 'uuid_race_1',
                watch_status: 'watch_later',
                instagram_sender_id: 'sender_alpha',
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          }
          // 3) Guarded PATCH includes strict atomic `.or(...)` ownership filter (rejects unattributed active too) and matches 0 rows (null)
          if (method === 'PATCH') {
            if (
              target.includes('watch_status.neq.watch_later') &&
              target.includes('sender_beta') &&
              !target.includes('instagram_sender_id.is.null') &&
              !target.includes('instagram_sender_id.eq.%22%22')
            ) {
              sawAtomicGuardOrFilter = true;
            }
            return new Response(JSON.stringify(null), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }
        }
      }
      return new Response('', { status: 404 });
    }) as typeof fetch;

    sentMessages.length = 0;
    await bot.handleWebhookPayload({
      object: 'instagram',
      entry: [
        {
          messaging: [
            { sender: { id: 'sender_beta' }, message: { text: 'https://www.instagram.com/reel/DRaceConflict1/ 30m' } },
          ],
        },
      ],
    });

    assert.strictEqual(sawAtomicGuardOrFilter, true, 'Supabase update must include atomic PostgREST sender ownership guard');
    assert.strictEqual(sentMessages.length, 1);
    assert.strictEqual(sentMessages[0].recipientId, 'sender_beta');
    assert.ok(sentMessages[0].text.includes('already has an active reminder'));
    assert.ok(!sentMessages[0].text.includes('Added to your Watch Later'));

    await assert.rejects(
      () =>
        Repository.upsertSavedReel({
          instagram_media_id: 'export_race_1',
          shortcode: 'DRaceConflict1',
          reel_url: 'https://www.instagram.com/reel/DRaceConflict1/',
          media_type: 'reel',
          creator_id: 'creator_race_1',
          taken_at: new Date().toISOString(),
          first_detected_at: new Date().toISOString(),
          save_order_rank: 1,
          watch_status: 'watch_later',
          instagram_sender_id: 'sender_beta',
        }),
      (e: unknown) => e instanceof SenderReminderConflictError
    );
  } finally {
    resetSupabaseClientForTests();
    globalThis.fetch = originalFetch;
    if (prevUrl !== undefined) process.env.SUPABASE_URL = prevUrl;
    else delete process.env.SUPABASE_URL;
    if (prevServiceKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = prevServiceKey;
    else delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (prevAnonKey !== undefined) process.env.SUPABASE_ANON_KEY = prevAnonKey;
    else delete process.env.SUPABASE_ANON_KEY;
  }
});

test('Repository and MetaInstagramBotService protect unattributed active reminders while preserving admin rescheduling, post-watched claiming, and scoped stop updates', async () => {
  const prevUrl = process.env.SUPABASE_URL;
  const prevServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const prevAnonKey = process.env.SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_ANON_KEY;

  const originalFetch = globalThis.fetch;
  const { resetSupabaseClientForTests } = await import('../src/db/client.ts');
  const { Repository, SenderReminderConflictError } = await import('../src/db/repository.ts');
  try {
    Repository.resetMemoryStoreForTests();
    globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch;

    const sentMessages: Array<{ recipientId: string; text: string }> = [];
    const bot = new MetaInstagramBotService();
    bot.sendDirectMessage = async (recipientId: string, text: string) => {
      sentMessages.push({ recipientId, text });
      return true;
    };

    const creator = await Repository.upsertCreator({
      instagram_user_id: 'admin_creator_1',
      username: 'admin_creator',
      display_name: 'Admin Creator',
    });

    const initialAdminReminderAt = new Date(Date.now() + 10 * 3600 * 1000).toISOString();
    await Repository.upsertSavedReel({
      instagram_media_id: 'admin_media_1',
      shortcode: 'DAdminActive1',
      reel_url: 'https://www.instagram.com/reel/DAdminActive1/',
      media_type: 'reel',
      creator_id: creator.id,
      taken_at: new Date().toISOString(),
      first_detected_at: new Date().toISOString(),
      save_order_rank: 1,
      watch_status: 'watch_later',
      reminder_interval_hours: 10,
      next_reminder_at: initialAdminReminderAt,
      is_saved_on_instagram: true,
    });

    // 1. Outside sender sharing the same shortcode gets their own isolated row without altering admin's unattributed reminder or ownership
    await bot.handleWebhookPayload({
      object: 'instagram',
      entry: [
        {
          messaging: [
            { sender: { id: 'outside_sender_1' }, message: { text: 'https://www.instagram.com/reel/DAdminActive1/ 15m' } },
          ],
        },
      ],
    });

    assert.strictEqual(sentMessages.length, 1);
    assert.strictEqual(sentMessages[0].recipientId, 'outside_sender_1');
    assert.ok(sentMessages[0].text.includes('Added to your Watch Later'));

    const untouchedAdminItem = await Repository.getSavedItemByShortcode('DAdminActive1', null);
    assert.strictEqual(untouchedAdminItem?.watch_status, 'watch_later');
    assert.strictEqual(untouchedAdminItem?.instagram_sender_id, undefined);
    assert.strictEqual(untouchedAdminItem?.next_reminder_at, initialAdminReminderAt);

    const isolatedOutsideItem = await Repository.getSavedItemByShortcode('DAdminActive1', 'outside_sender_1');
    assert.strictEqual(isolatedOutsideItem?.watch_status, 'watch_later');
    assert.strictEqual(isolatedOutsideItem?.instagram_sender_id, 'outside_sender_1');
    assert.strictEqual(isolatedOutsideItem?.reminder_interval_seconds, 900);
    assert.notStrictEqual(isolatedOutsideItem?.id, untouchedAdminItem?.id);

    // Direct Repository upsert targeting admin's exact instagram_media_id must still fail closed on unattributed active reminder
    await assert.rejects(
      () =>
        Repository.upsertSavedReel({
          instagram_media_id: 'admin_media_1',
          shortcode: 'DAdminActive1',
          reel_url: 'https://www.instagram.com/reel/DAdminActive1/',
          media_type: 'reel',
          creator_id: creator.id,
          taken_at: new Date().toISOString(),
          first_detected_at: new Date().toISOString(),
          save_order_rank: 1,
          watch_status: 'watch_later',
          instagram_sender_id: 'outside_sender_1',
        }),
      (e: unknown) => e instanceof SenderReminderConflictError
    );

    // 2. Admin rescheduling (no incoming sender) still works on unattributed active reminder
    const rescheduledAdminAt = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
    const adminUpdated = await Repository.upsertSavedReel({
      instagram_media_id: 'admin_media_1',
      shortcode: 'DAdminActive1',
      reel_url: 'https://www.instagram.com/reel/DAdminActive1/',
      media_type: 'reel',
      creator_id: creator.id,
      taken_at: new Date().toISOString(),
      first_detected_at: new Date().toISOString(),
      save_order_rank: 1,
      watch_status: 'watch_later',
      reminder_interval_hours: 2,
      next_reminder_at: rescheduledAdminAt,
      is_saved_on_instagram: true,
    });
    assert.strictEqual(adminUpdated?.next_reminder_at, rescheduledAdminAt);
    assert.strictEqual(adminUpdated?.reminder_interval_hours, 2);

    // 3. Admin stopping unattributed reminders only stops admin's row, leaving outside_sender_1's row active
    const adminStop = await Repository.markWatchedForInstagramSender('', { includeUnattributedFallback: true });
    assert.strictEqual(adminStop.updatedReels.length, 1);
    assert.strictEqual((await Repository.getSavedItemByShortcode('DAdminActive1', null))?.watch_status, 'watched');
    assert.strictEqual((await Repository.getSavedItemByShortcode('DAdminActive1', 'outside_sender_1'))?.watch_status, 'watch_later');

    sentMessages.length = 0;
    await bot.handleWebhookPayload({
      object: 'instagram',
      entry: [
        {
          messaging: [
            { sender: { id: 'outside_sender_1' }, message: { text: 'https://www.instagram.com/reel/DAdminActive1/ 45m' } },
          ],
        },
      ],
    });
    const updatedOutsideItem = await Repository.getSavedItemByShortcode('DAdminActive1', 'outside_sender_1');
    assert.strictEqual(updatedOutsideItem?.watch_status, 'watch_later');
    assert.strictEqual(updatedOutsideItem?.instagram_sender_id, 'outside_sender_1');
    assert.strictEqual(updatedOutsideItem?.reminder_interval_seconds, 2700);
    assert.ok(sentMessages[0]?.text.includes('Added to your Watch Later!'));

    Repository.resetMemoryStoreForTests();

    // 4. Supabase atomic guard rejects concurrent unattributed active takeover AND scopes markWatched PATCH by sender
    resetSupabaseClientForTests();
    process.env.SUPABASE_URL = 'https://mock-reeler-test.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock-service-role-key';

    let sawUnattrStrictGuard = false;
    const stopPatchUrls: string[] = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      const method = (init?.method || 'GET').toUpperCase();
      if (target.startsWith('https://mock-reeler-test.supabase.co/rest/v1/saved_reels')) {
        if (method === 'POST') {
          return new Response(JSON.stringify(null), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (
          method === 'GET' &&
          (target.includes('instagram_media_id=eq.unattr_media_1') || target.includes('shortcode=eq.DUnattrRace'))
        ) {
          return new Response(
            JSON.stringify({
              id: 'uuid_unattr_1',
              instagram_media_id: 'unattr_media_1',
              shortcode: 'DUnattrRace',
              reel_url: 'https://www.instagram.com/reel/DUnattrRace/',
              media_type: 'reel',
              creator_id: 'creator_1',
              watch_status: 'unwatched',
              instagram_sender_id: null,
              is_saved_on_instagram: true,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (method === 'GET' && target.includes('id=eq.uuid_unattr_1')) {
          return new Response(
            JSON.stringify({
              id: 'uuid_unattr_1',
              watch_status: 'watch_later',
              instagram_sender_id: null,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (method === 'PATCH' && target.includes('id=eq.uuid_unattr_1')) {
          if (
            target.includes('watch_status.neq.watch_later') &&
            target.includes('outside_sender_1') &&
            !target.includes('instagram_sender_id.is.null')
          ) {
            sawUnattrStrictGuard = true;
          }
          return new Response(JSON.stringify(null), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (method === 'GET' && target.includes('watch_status=eq.watch_later')) {
          return new Response(
            JSON.stringify([
              {
                id: 'uuid_stop_1',
                shortcode: 'DStopGuard1',
                reel_url: 'https://www.instagram.com/reel/DStopGuard1/',
                media_type: 'reel',
                watch_status: 'watch_later',
                instagram_sender_id: target.includes('instagram_sender_id=eq.sender_alpha') ? 'sender_alpha' : null,
                updated_at: new Date().toISOString(),
                created_at: new Date().toISOString(),
                creator: { id: 'c1', instagram_user_id: 'u1', username: 'creator1' },
              },
            ]),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (method === 'PATCH' && target.includes('watch_status=eq.watch_later')) {
          stopPatchUrls.push(target);
          return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
      }
      return new Response('', { status: 404 });
    }) as typeof fetch;

    await assert.rejects(
      () =>
        Repository.upsertSavedReel({
          instagram_media_id: 'unattr_media_1',
          shortcode: 'DUnattrRace',
          reel_url: 'https://www.instagram.com/reel/DUnattrRace/',
          media_type: 'reel',
          creator_id: 'creator_1',
          taken_at: new Date().toISOString(),
          first_detected_at: new Date().toISOString(),
          save_order_rank: 1,
          watch_status: 'watch_later',
          instagram_sender_id: 'outside_sender_1',
        }),
      (e: unknown) => e instanceof SenderReminderConflictError
    );
    assert.strictEqual(sawUnattrStrictGuard, true, 'Supabase update must reject active unattributed takeover atomically');

    await Repository.markWatchedForInstagramSender('sender_alpha', { markAll: true });
    await Repository.markWatchedForInstagramSender('', { markAll: true, includeUnattributedFallback: true });

    assert.strictEqual(stopPatchUrls.length, 2);
    assert.ok(
      stopPatchUrls[0].includes('instagram_sender_id=eq.sender_alpha'),
      'Exact-sender stop UPDATE must retain sender predicate so a concurrently reclaimed item cannot be cleared'
    );
    assert.ok(
      stopPatchUrls[1].includes('instagram_sender_id.is.null') && stopPatchUrls[1].includes('instagram_sender_id.eq.'),
      'Unattributed fallback stop UPDATE must retain unattributed predicate'
    );
  } finally {
    resetSupabaseClientForTests();
    globalThis.fetch = originalFetch;
    if (prevUrl !== undefined) process.env.SUPABASE_URL = prevUrl;
    else delete process.env.SUPABASE_URL;
    if (prevServiceKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = prevServiceKey;
    else delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (prevAnonKey !== undefined) process.env.SUPABASE_ANON_KEY = prevAnonKey;
    else delete process.env.SUPABASE_ANON_KEY;
  }
});

test('isMetaMessagingWindowError accurately recognizes 24h messaging window errors', () => {
  assert.strictEqual(isMetaMessagingWindowError(null), false);
  assert.strictEqual(isMetaMessagingWindowError(undefined), false);
  assert.strictEqual(isMetaMessagingWindowError({}), false);
  assert.strictEqual(isMetaMessagingWindowError({ error: { code: 190, message: 'Invalid token' } }), false);

  assert.strictEqual(
    isMetaMessagingWindowError({
      error: { code: 10, error_subcode: 2018278, message: 'This message is sent outside of allowed window.' },
    }),
    true
  );

  assert.strictEqual(
    isMetaMessagingWindowError({
      error: { code: 10, message: 'Cannot message user outside the 24 hour window' },
    }),
    true
  );
});

test('MetaInstagramBotService.sendDirectMessage supports standard delivery and HUMAN_AGENT fallback', async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.META_PAGE_ACCESS_TOKEN;
  process.env.META_PAGE_ACCESS_TOKEN = 'test_meta_token';

  try {
    const service = new MetaInstagramBotService();

    // 1. Standard success scenario
    const sentBodies: any[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      sentBodies.push(JSON.parse((init?.body as string) || '{}'));
      return new Response(JSON.stringify({ recipient_id: 'user_1', message_id: 'mid_1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const res1 = await service.sendDirectMessage('user_1', 'Hello standard');
    assert.strictEqual(res1, true);
    assert.strictEqual(sentBodies.length, 1);
    assert.strictEqual(sentBodies[0].recipient.id, 'user_1');
    assert.strictEqual(sentBodies[0].tag, undefined);

    // 2. Window expired scenario -> automatic fallback to HUMAN_AGENT tag
    const fallbackCalls: any[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) || '{}');
      fallbackCalls.push(body);
      if (!body.tag) {
        // First call without tag fails with 24h window error
        return new Response(
          JSON.stringify({
            error: {
              code: 10,
              error_subcode: 2018278,
              message: 'This message is sent outside of allowed window.',
            },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      // Second call with HUMAN_AGENT succeeds
      return new Response(JSON.stringify({ recipient_id: 'user_2', message_id: 'mid_2' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const res2 = await service.sendDirectMessage('user_2', 'Reminder after 24h');
    assert.strictEqual(res2, true);
    assert.strictEqual(fallbackCalls.length, 2, 'Must have attempted standard then HUMAN_AGENT retry');
    assert.strictEqual(fallbackCalls[0].tag, undefined);
    assert.strictEqual(fallbackCalls[1].tag, 'HUMAN_AGENT');

    // 3. Explicit tag scenario
    const explicitCalls: any[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      explicitCalls.push(JSON.parse((init?.body as string) || '{}'));
      return new Response(JSON.stringify({ recipient_id: 'user_3', message_id: 'mid_3' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const res3 = await service.sendDirectMessage('user_3', 'Explicit agent message', { tag: 'HUMAN_AGENT' });
    assert.strictEqual(res3, true);
    assert.strictEqual(explicitCalls.length, 1);
    assert.strictEqual(explicitCalls[0].tag, 'HUMAN_AGENT');

    // 4. Fallback disabled scenario
    const noFallbackCalls: any[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      noFallbackCalls.push(JSON.parse((init?.body as string) || '{}'));
      return new Response(
        JSON.stringify({
          error: { code: 10, error_subcode: 2018278, message: 'outside window' },
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    const res4 = await service.sendDirectMessage('user_4', 'No fallback allowed', {
      allowHumanAgentFallback: false,
    });
    assert.strictEqual(res4, false);
    assert.strictEqual(noFallbackCalls.length, 1, 'Should not retry when fallback disabled');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken !== undefined) process.env.META_PAGE_ACCESS_TOKEN = originalToken;
    else delete process.env.META_PAGE_ACCESS_TOKEN;
  }
});

test('MetaInstagramBotService - responds to "vault" DM command with personalized access link', async () => {
  const service = new MetaInstagramBotService();
  const sentMessages: { recipientId: string; text: string }[] = [];
  (service as any).sendDirectMessage = async (recipientId: string, text: string) => {
    sentMessages.push({ recipientId, text });
    return true;
  };

  await service.handleWebhookPayload({
    object: 'instagram',
    entry: [
      {
        messaging: [
          {
            sender: { id: 'sender_vault_requester_123' },
            message: { text: 'vault' },
          },
        ],
      },
    ],
  });

  assert.strictEqual(sentMessages.length, 1);
  assert.strictEqual(sentMessages[0].recipientId, 'sender_vault_requester_123');
  assert.ok(sentMessages[0].text.includes('Your Personal Vault Link:'), `Got: ${sentMessages[0].text}`);
  assert.ok(sentMessages[0].text.includes('?key='), `Must contain magic key: ${sentMessages[0].text}`);
  assert.ok(sentMessages[0].text.includes('optional companion'), `Should remind that web is optional: ${sentMessages[0].text}`);
});

test('MetaInstagramBotService - responds to "code" / "login" DM command with 6-digit OTP code', async () => {
  const service = new MetaInstagramBotService();
  const sentMessages: { recipientId: string; text: string }[] = [];
  (service as any).sendDirectMessage = async (recipientId: string, text: string) => {
    sentMessages.push({ recipientId, text });
    return true;
  };

  await service.handleWebhookPayload({
    object: 'instagram',
    entry: [
      {
        messaging: [
          {
            sender: { id: 'sender_code_requester_456' },
            message: { text: 'code' },
          },
        ],
      },
    ],
  });

  assert.strictEqual(sentMessages.length, 1);
  assert.strictEqual(sentMessages[0].recipientId, 'sender_code_requester_456');
  assert.ok(sentMessages[0].text.includes('Your Reeler Login Code:'), `Got: ${sentMessages[0].text}`);
  assert.ok(/\b\d{6}\b/.test(sentMessages[0].text), `Must contain 6-digit numeric OTP: ${sentMessages[0].text}`);
  assert.ok(sentMessages[0].text.includes('valid for 10 minutes'), `Must state validity: ${sentMessages[0].text}`);
});

test('MetaInstagramBotService - admin sender receiving "code" yields admin session upon verification', async () => {
  const adminSenderId = 'admin_instagram_sender_777';
  const service = new MetaInstagramBotService({ adminUserId: adminSenderId });
  const sentMessages: { recipientId: string; text: string }[] = [];
  (service as any).sendDirectMessage = async (recipientId: string, text: string) => {
    sentMessages.push({ recipientId, text });
    return true;
  };

  await service.handleWebhookPayload({
    object: 'instagram',
    entry: [
      {
        messaging: [
          {
            sender: { id: adminSenderId },
            message: { text: 'code' },
          },
        ],
      },
    ],
  });

  assert.strictEqual(sentMessages.length, 1);
  const match = sentMessages[0].text.match(/\b\d{6}\b/);
  assert.ok(match, 'Must find 6-digit OTP code in admin DM');

  const { verifyOtp } = await import('../src/services/vaultAuthService.ts');
  const verification = verifyOtp(match[0]);
  assert.strictEqual(verification.valid, true);
  assert.strictEqual(verification.session?.role, 'admin', 'Admin sender must receive admin role OTP');
});

test('MetaInstagramBotService - "delete my data" permanently erases sender records and replies', async () => {
  const { Repository } = await import('../src/db/repository.ts');
  const purgeSenderId = 'purge_test_sender_888';
  const service = new MetaInstagramBotService();
  const sentMessages: { recipientId: string; text: string }[] = [];
  (service as any).sendDirectMessage = async (recipientId: string, text: string) => {
    sentMessages.push({ recipientId, text });
    return true;
  };

  // Seed a reel for this sender
  await Repository.upsertSavedReel({
    instagram_media_id: 'shortcode_Cpurge123',
    shortcode: 'Cpurge123',
    reel_url: 'https://www.instagram.com/reel/Cpurge123/',
    instagram_sender_id: purgeSenderId,
    watch_status: 'watch_later',
  });

  // Verify reel exists
  const lastReelBefore = await Repository.getLastReelForInstagramSender(purgeSenderId);
  assert.ok(lastReelBefore, 'Reel must exist before deletion');

  // Send deletion command
  await service.handleWebhookPayload({
    object: 'instagram',
    entry: [
      {
        messaging: [
          {
            sender: { id: purgeSenderId },
            message: { text: 'delete my data' },
          },
        ],
      },
    ],
  });

  assert.strictEqual(sentMessages.length, 1);
  assert.ok(sentMessages[0].text.includes('data deletion request has been processed'));
  assert.ok(sentMessages[0].text.includes('Permanently removed'));

  // Verify reel was eradicated
  const lastReelAfter = await Repository.getLastReelForInstagramSender(purgeSenderId);
  assert.strictEqual(lastReelAfter, null, 'Reel must be permanently deleted');

  // Verify deletion barrier throws SenderDeletionBarrierError
  const { SenderDeletionBarrierError } = await import('../src/db/repository.ts');
  await assert.rejects(
    () =>
      Repository.upsertSavedReel({
        instagram_media_id: 'shortcode_CpurgeRaced',
        shortcode: 'CpurgeRaced',
        reel_url: 'https://www.instagram.com/reel/CpurgeRaced/',
        instagram_sender_id: purgeSenderId,
        watch_status: 'watch_later',
      }),
    SenderDeletionBarrierError
  );

  // Verify bot sends helpful retry notification if user shares a reel during barrier
  await service.handleWebhookPayload({
    object: 'instagram',
    entry: [
      {
        messaging: [
          {
            sender: { id: purgeSenderId },
            message: { text: 'https://www.instagram.com/reel/CpurgeRaced/' },
          },
        ],
      },
    ],
  });
  assert.strictEqual(sentMessages.length, 2);
  assert.ok(sentMessages[1].text.includes('Please wait 60 seconds'));
});

test('MetaInstagramBotService - "delete my data" sends error reply when deletion throws', async () => {
  const { Repository } = await import('../src/db/repository.ts');
  const failingSenderId = 'failing_deletion_sender_999';
  const service = new MetaInstagramBotService();
  const sentMessages: { recipientId: string; text: string }[] = [];
  (service as any).sendDirectMessage = async (recipientId: string, text: string) => {
    sentMessages.push({ recipientId, text });
    return true;
  };

  const originalDelete = Repository.deleteUserDataForSender;
  try {
    Repository.deleteUserDataForSender = async () => {
      throw new Error('Simulated database network failure');
    };

    await service.handleWebhookPayload({
      object: 'instagram',
      entry: [
        {
          messaging: [
            {
              sender: { id: failingSenderId },
              message: { text: 'delete my data' },
            },
          ],
        },
      ],
    });

    assert.strictEqual(sentMessages.length, 1);
    assert.ok(sentMessages[0].text.includes('encountered an issue processing your data deletion request'));
  } finally {
    Repository.deleteUserDataForSender = originalDelete;
  }
});

test('MetaInstagramBotService captures webhook attachment payload.title as fallback caption when HTML metadata is blocked', async () => {
  const prevUrl = process.env.SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const prevAnon = process.env.SUPABASE_ANON_KEY;
  const prevMetaToken = process.env.META_PAGE_ACCESS_TOKEN;
  const prevProxy = process.env.METADATA_PROXY_URL;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_ANON_KEY;
  delete process.env.META_PAGE_ACCESS_TOKEN;
  delete process.env.METADATA_PROXY_URL;

  const originalFetch = globalThis.fetch;
  const { Repository } = await import('../src/db/repository.ts');
  const { resetFeedMetaResolverStateForTests } = await import('../src/services/reelMetadataResolver.ts');
  try {
    Repository.resetMemoryStoreForTests();
    resetFeedMetaResolverStateForTests();
    // Simulate Instagram login wall returning HTML without OG tags
    globalThis.fetch = (async () => new Response('<html><head><title>Login • Instagram</title></head></html>', { status: 200 })) as typeof fetch;

    const bot = new MetaInstagramBotService();
    bot.sendDirectMessage = async () => true;

    await bot.handleWebhookPayload({
      object: 'instagram',
      entry: [
        {
          messaging: [
            {
              sender: { id: 'sender_title_fallback' },
              message: {
                attachments: [
                  {
                    type: 'ig_reel',
                    payload: {
                      reel_video_id: '18105532976531077',
                      title: 'Thank you Akira Toriyama #dragonball',
                      url: 'https://www.instagram.com/reel/DTitleFallback1/',
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    const saved = await Repository.getSavedItemByShortcode('DTitleFallback1', 'sender_title_fallback');
    assert.ok(saved, 'Reel should be saved for sender');
    assert.strictEqual(saved.caption, 'Thank you Akira Toriyama #dragonball');
    assert.strictEqual(saved.instagram_media_id, 'dm_sender_title_fallback_DTitleFallback1');

    // Also verify entry.changes path preserves payload.title
    await bot.handleWebhookPayload({
      object: 'instagram',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                sender: { id: 'sender_changes_title' },
                message: {
                  attachments: [
                    {
                      type: 'ig_reel',
                      payload: {
                        title: 'Changes event title fallback',
                        url: 'https://www.instagram.com/reel/DChangesTitle1/',
                      },
                    },
                  ],
                },
              },
            },
          ],
        },
      ],
    });
    const savedFromChanges = await Repository.getSavedItemByShortcode('DChangesTitle1', 'sender_changes_title');
    assert.ok(savedFromChanges, 'Changes reel should be saved for sender');
    assert.strictEqual(savedFromChanges.caption, 'Changes event title fallback');
    Repository.resetMemoryStoreForTests();
  } finally {
    globalThis.fetch = originalFetch;
    if (prevUrl !== undefined) process.env.SUPABASE_URL = prevUrl;
    if (prevKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
    if (prevAnon !== undefined) process.env.SUPABASE_ANON_KEY = prevAnon;
    if (prevMetaToken !== undefined) process.env.META_PAGE_ACCESS_TOKEN = prevMetaToken;
    if (prevProxy !== undefined) process.env.METADATA_PROXY_URL = prevProxy;
  }
});

test('fetchReelMetadata supports Meta oEmbed fallback with code-10 cooldown and METADATA_PROXY_URL relay', async () => {
  const prevMetaToken = process.env.META_PAGE_ACCESS_TOKEN;
  const prevProxy = process.env.METADATA_PROXY_URL;
  const prevProxyToken = process.env.METADATA_PROXY_TOKEN;
  const originalFetch = globalThis.fetch;

  const { fetchReelMetadata, resetFeedMetaResolverStateForTests } = await import('../src/services/reelMetadataResolver.ts');

  try {
    // 1. Meta oEmbed success path
    resetFeedMetaResolverStateForTests();
    process.env.META_PAGE_ACCESS_TOKEN = 'test_oembed_token';
    delete process.env.METADATA_PROXY_URL;

    globalThis.fetch = (async (url: unknown) => {
      const target = String(url);
      if (target.includes('graph.facebook.com/v21.0/instagram_oembed')) {
        return new Response(
          JSON.stringify({
            author_name: 'OEmbedCreator',
            thumbnail_url: 'https://scontent.cdninstagram.com/v/thumb.jpg',
            title: 'Official oEmbed caption',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('<html><title>Login</title></html>', { status: 200 });
    }) as typeof fetch;

    const oEmbedMeta = await fetchReelMetadata('DOEmbedOk1', undefined, 'reel');
    assert.strictEqual(oEmbedMeta.username, 'oembedcreator');
    assert.strictEqual(oEmbedMeta.thumbnailUrl, 'https://scontent.cdninstagram.com/v/thumb.jpg');
    assert.strictEqual(oEmbedMeta.caption, 'Official oEmbed caption');
    assert.strictEqual(oEmbedMeta.isClips, null, 'oEmbed without EFG must not assume isClips from preferredPath');
    assert.strictEqual(oEmbedMeta.mediaKind, 'UNKNOWN');

    // 2. Meta oEmbed code-10 cooldown + METADATA_PROXY_URL relay fallback even after direct network error
    resetFeedMetaResolverStateForTests();
    process.env.METADATA_PROXY_URL = 'https://proxy.example.workers.dev/';
    process.env.METADATA_PROXY_TOKEN = 'secret_proxy_tok';
    let oEmbedCalls = 0;
    let proxyAuthHeader = '';

    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      if (target.includes('graph.facebook.com/v21.0/instagram_oembed')) {
        oEmbedCalls++;
        return new Response(
          JSON.stringify({ error: { code: 10, message: 'Meta oEmbed Read requires review' } }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (target.startsWith('https://proxy.example.workers.dev/')) {
        proxyAuthHeader = String((init?.headers as Record<string, string> | undefined)?.Authorization || '');
        return new Response(
          `<html><head>
            <meta property="og:url" content="https://www.instagram.com/relay_creator/reel/DProxyOk1/" />
            <meta property="og:title" content="Relay Creator (@relay_creator) on Instagram" />
            <meta property="og:image" content="https://scontent.cdninstagram.com/v/proxy_thumb.jpg" />
            <meta property="og:description" content="10 likes: &quot;Proxy caption&quot;." />
          </head></html>`,
          { status: 200, headers: { 'Content-Type': 'text/html' } }
        );
      }
      throw new TypeError('Simulated direct network timeout');
    }) as typeof fetch;

    const proxied1 = await fetchReelMetadata('DProxyOk1', undefined, 'reel');
    assert.strictEqual(proxied1.username, 'relay_creator');
    assert.strictEqual(proxied1.thumbnailUrl, 'https://scontent.cdninstagram.com/v/proxy_thumb.jpg');
    assert.strictEqual(proxyAuthHeader, 'Bearer secret_proxy_tok');
    assert.strictEqual(oEmbedCalls, 1);

    // Second call must skip oEmbed due to 1h cooldown after code 10
    await fetchReelMetadata('DProxyOk2', undefined, 'reel');
    assert.strictEqual(oEmbedCalls, 1, 'oEmbed should remain paused during cooldown after code 10');
  } finally {
    globalThis.fetch = originalFetch;
    resetFeedMetaResolverStateForTests();
    if (prevMetaToken !== undefined) process.env.META_PAGE_ACCESS_TOKEN = prevMetaToken;
    else delete process.env.META_PAGE_ACCESS_TOKEN;
    if (prevProxy !== undefined) process.env.METADATA_PROXY_URL = prevProxy;
    else delete process.env.METADATA_PROXY_URL;
    if (prevProxyToken !== undefined) process.env.METADATA_PROXY_TOKEN = prevProxyToken;
    else delete process.env.METADATA_PROXY_TOKEN;
  }
});
