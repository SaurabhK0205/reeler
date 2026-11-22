import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration, formatTargetTime } from '../src/utils/duration.ts';
import { parseTargetedReminderUpdateCommand } from '../src/utils/reelMessages.ts';
import { resolveTimeZone, getTimeZoneSummary, getTimeZoneAbbreviation } from '../src/utils/timezone.ts';
import { Repository, SenderDeletionBarrierError } from '../src/db/repository.ts';
import { MetaInstagramBotService } from '../src/services/metaInstagramBotService.ts';
import { apiRouter } from '../src/api/router.ts';

test('Timezone Resolution - resolves standard abbreviations, cities, and offsets', () => {
  assert.strictEqual(resolveTimeZone('ist'), 'Asia/Kolkata');
  assert.strictEqual(resolveTimeZone('EST'), 'America/New_York');
  assert.strictEqual(resolveTimeZone('edt'), 'America/New_York');
  assert.strictEqual(resolveTimeZone('pst'), 'America/Los_Angeles');
  assert.strictEqual(resolveTimeZone('pdt'), 'America/Los_Angeles');
  assert.strictEqual(resolveTimeZone('cst'), 'America/Chicago');
  assert.strictEqual(resolveTimeZone('mst'), 'America/Denver');
  assert.strictEqual(resolveTimeZone('bst'), 'Europe/London');
  assert.strictEqual(resolveTimeZone('gmt'), 'UTC');
  assert.strictEqual(resolveTimeZone('utc'), 'UTC');
  assert.strictEqual(resolveTimeZone('jst'), 'Asia/Tokyo');
  assert.strictEqual(resolveTimeZone('aest'), 'Australia/Sydney');

  // Cities
  assert.strictEqual(resolveTimeZone('London'), 'Europe/London');
  assert.strictEqual(resolveTimeZone('New York'), 'America/New_York');
  assert.strictEqual(resolveTimeZone('nyc'), 'America/New_York');
  assert.strictEqual(resolveTimeZone('Los Angeles'), 'America/Los_Angeles');
  assert.strictEqual(resolveTimeZone('San Francisco'), 'America/Los_Angeles');
  assert.strictEqual(resolveTimeZone('Chicago'), 'America/Chicago');
  assert.strictEqual(resolveTimeZone('Tokyo'), 'Asia/Tokyo');
  assert.strictEqual(resolveTimeZone('Sydney'), 'Australia/Sydney');
  assert.strictEqual(resolveTimeZone('Paris'), 'Europe/Paris');
  assert.strictEqual(resolveTimeZone('Berlin'), 'Europe/Berlin');
  assert.strictEqual(resolveTimeZone('Mumbai'), 'Asia/Kolkata');
  assert.strictEqual(resolveTimeZone('Delhi'), 'Asia/Kolkata');
  assert.strictEqual(resolveTimeZone('Dubai'), 'Asia/Dubai');

  // Direct IANA
  assert.strictEqual(resolveTimeZone('Europe/London'), 'Europe/London');
  assert.strictEqual(resolveTimeZone('America/New_York'), 'America/New_York');
  assert.strictEqual(resolveTimeZone('Asia/Kolkata'), 'Asia/Kolkata');

  // Offsets
  assert.strictEqual(resolveTimeZone('+5:30'), 'Asia/Kolkata');
  assert.strictEqual(resolveTimeZone('+05:30'), 'Asia/Kolkata');

  // Inherited properties & prototype poisoning attempts must return null
  assert.strictEqual(resolveTimeZone('__proto__'), null);
  assert.strictEqual(resolveTimeZone('constructor'), null);
  assert.strictEqual(resolveTimeZone('toString'), null);
  assert.strictEqual(resolveTimeZone('valueOf'), null);
  assert.strictEqual(resolveTimeZone('hasOwnProperty'), null);

  // Invalid
  assert.strictEqual(resolveTimeZone('mars/olympus_mons'), null);
  assert.strictEqual(resolveTimeZone(''), null);
});

test('Duration & Timezone - converges across Daylight Saving Time (DST) transitions', () => {
  // Saturday March 7, 2026 at 15:00 UTC (10:00 AM EST in New York)
  // DST starts in New York on Sunday March 8, 2026 at 2:00 AM (skipping to 3:00 AM EDT)
  const march7 = new Date('2026-03-07T15:00:00.000Z');
  const parsedDst = parseDuration('tomorrow at 3:30am', march7, 'America/New_York');
  assert.ok(parsedDst);
  // 3:30 AM EDT is UTC-4 => 07:30 UTC
  assert.strictEqual(parsedDst.targetDate.toISOString(), '2026-03-08T07:30:00.000Z');
  assert.strictEqual(parsedDst.formattedTarget, 'tomorrow at 3:30 AM EDT');
});

test('Duration & Timezone - formats target times across multiple global regions', () => {
  // 16:29:49 UTC is:
  // - 21:59:49 IST (9:59 PM) in Asia/Kolkata
  // - 11:29:49 EST (11:29 AM) in America/New_York
  // - 16:29:49 GMT (4:29 PM) in Europe/London
  // - 16:29:49 UTC in UTC
  const now = new Date('2026-11-15T16:29:49.000Z');
  const target30s = new Date('2026-11-15T16:30:19.000Z');

  // IST (India)
  const formattedIst = formatTargetTime(target30s, now, 'Asia/Kolkata');
  assert.strictEqual(formattedIst, 'today at 10:00:19 PM IST');

  // EST (New York)
  const formattedEst = formatTargetTime(target30s, now, 'America/New_York');
  assert.strictEqual(formattedEst, 'today at 11:30:19 AM EST');

  // GMT (London)
  const formattedGmt = formatTargetTime(target30s, now, 'Europe/London');
  assert.strictEqual(formattedGmt, 'today at 4:30:19 PM GMT');

  // UTC
  const formattedUtc = formatTargetTime(target30s, now, 'UTC');
  assert.strictEqual(formattedUtc, 'today at 4:30:19 PM UTC');

  // 10 hours later
  const target10h = new Date('2026-11-16T02:29:49.000Z');
  assert.strictEqual(formatTargetTime(target10h, now, 'Asia/Kolkata'), 'tomorrow at 7:59 AM IST');
  assert.strictEqual(formatTargetTime(target10h, now, 'America/New_York'), 'today at 9:29 PM EST');
  assert.strictEqual(formatTargetTime(target10h, now, 'Europe/London'), 'tomorrow at 2:29 AM GMT');
  assert.strictEqual(formatTargetTime(target10h, now, 'UTC'), 'tomorrow at 2:29 AM UTC');
});

test('Duration & Timezone - parses natural language times in user local timezone', () => {
  // Sunday Nov 15 2026 at 16:29:49 UTC
  const now = new Date('2026-11-15T16:29:49.000Z');

  // 1. User in New York says "tomorrow at 5pm" (5pm EST = 22:00 UTC)
  const parsedNy = parseDuration('tomorrow at 5pm', now, 'America/New_York');
  assert.ok(parsedNy);
  assert.strictEqual(parsedNy.targetDate.toISOString(), '2026-11-16T22:00:00.000Z');
  assert.strictEqual(parsedNy.formattedTarget, 'tomorrow at 5:00 PM EST');

  // 2. User in London says "tomorrow at 5pm" (5pm GMT = 17:00 UTC)
  const parsedLondon = parseDuration('tomorrow at 5pm', now, 'Europe/London');
  assert.ok(parsedLondon);
  assert.strictEqual(parsedLondon.targetDate.toISOString(), '2026-11-16T17:00:00.000Z');
  assert.strictEqual(parsedLondon.formattedTarget, 'tomorrow at 5:00 PM GMT');

  // 3. User in Kolkata says "tomorrow at 5pm" (5pm IST = 11:30 UTC)
  const parsedKolkata = parseDuration('tomorrow at 5pm', now, 'Asia/Kolkata');
  assert.ok(parsedKolkata);
  assert.strictEqual(parsedKolkata.targetDate.toISOString(), '2026-11-16T11:30:00.000Z');
  assert.strictEqual(parsedKolkata.formattedTarget, 'tomorrow at 5:00 PM IST');
});

test('Repository - persists and retrieves sender timezone preferences', async () => {
  Repository.resetSenderTimezonesForTesting();

  // Default fallback when not set
  const defaultTz = await Repository.getSenderTimezone('user_default_123');
  assert.ok(defaultTz === 'UTC' || defaultTz === process.env.APP_TIMEZONE || defaultTz === process.env.TZ);

  // Set to New York
  const setNy = await Repository.setSenderTimezone('user_ny_1', 'New York');
  assert.strictEqual(setNy, 'America/New_York');
  const fetchedNy = await Repository.getSenderTimezone('user_ny_1');
  assert.strictEqual(fetchedNy, 'America/New_York');

  // Set to London
  const setLondon = await Repository.setSenderTimezone('user_london_1', 'London');
  assert.strictEqual(setLondon, 'Europe/London');
  const fetchedLondon = await Repository.getSenderTimezone('user_london_1');
  assert.strictEqual(fetchedLondon, 'Europe/London');

  // Set to IST
  const setIst = await Repository.setSenderTimezone('user_ist_1', 'ist');
  assert.strictEqual(setIst, 'Asia/Kolkata');
  const fetchedIst = await Repository.getSenderTimezone('user_ist_1');
  assert.strictEqual(fetchedIst, 'Asia/Kolkata');

  // Data deletion wipes preferences and restores configured default
  const originalAppTz = process.env.APP_TIMEZONE;
  const originalTz = process.env.TZ;
  try {
    process.env.APP_TIMEZONE = 'UTC';
    delete process.env.TZ;

    await Repository.deleteUserDataForSender('user_ny_1');
    const postDeletionTz = await Repository.getSenderTimezone('user_ny_1');
    assert.strictEqual(postDeletionTz, 'UTC');
  } finally {
    if (originalAppTz !== undefined) process.env.APP_TIMEZONE = originalAppTz; else delete process.env.APP_TIMEZONE;
    if (originalTz !== undefined) process.env.TZ = originalTz; else delete process.env.TZ;
  }
});

test('MetaInstagramBotService - handles timezone DM commands (tz, timezone)', async (t) => {
  // Lock clock to winter date so America/New_York is guaranteed to resolve to EST (UTC-5)
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-15T12:00:00Z') });
  Repository.resetSenderTimezonesForTesting();

  const sentMessages: string[] = [];
  const bot = new MetaInstagramBotService();
  bot.sendDirectMessage = async (_recipientId, text) => {
    sentMessages.push(text);
    return true;
  };

  // 1. Check default timezone
  sentMessages.length = 0;
  await (bot as any).processIncomingText('sender_tz_test', 'tz');
  assert.strictEqual(sentMessages.length, 1);
  assert.ok(sentMessages[0].includes('Your timezone is currently set to:'));

  // 2. Set timezone to New York
  sentMessages.length = 0;
  await (bot as any).processIncomingText('sender_tz_test', 'tz New York');
  assert.strictEqual(sentMessages.length, 1);
  assert.ok(sentMessages[0].includes('Timezone updated to America/New_York (EST'));

  // Verify repository updated
  const storedTz = await Repository.getSenderTimezone('sender_tz_test');
  assert.strictEqual(storedTz, 'America/New_York');

  // 3. Set timezone to London
  sentMessages.length = 0;
  await (bot as any).processIncomingText('sender_tz_test', 'timezone London');
  assert.strictEqual(sentMessages.length, 1);
  assert.ok(sentMessages[0].includes('Timezone updated to Europe/London (GMT'));

  // 4. Invalid timezone
  sentMessages.length = 0;
  await (bot as any).processIncomingText('sender_tz_test', 'tz Atlantis');
  assert.strictEqual(sentMessages.length, 1);
  assert.ok(sentMessages[0].includes('Could not recognize timezone "Atlantis"'));
});

test('Repository - concurrent setSenderTimezone and deletion track generations', async () => {
  Repository.resetSenderTimezonesForTesting();

  const senderId = 'user_concurrent_race';
  await Repository.setSenderTimezone(senderId, 'America/Chicago');
  const cached = await Repository.getSenderTimezone(senderId);
  assert.strictEqual(cached, 'America/Chicago');

  // Deletion increments generation and wipes cached value
  await Repository.deleteUserDataForSender(senderId);
  const fallback = await Repository.getSenderTimezone(senderId);
  assert.strictEqual(fallback, process.env.APP_TIMEZONE || process.env.TZ || 'UTC');

  // Verify that lookups started during pending deletion are superseded by post-delete generation bump
  const pendingLookupGen = (Repository as any).senderTimezoneGenerations.get(senderId) || 0;
  await Repository.deleteUserDataForSender(senderId);
  const postGen = (Repository as any).senderTimezoneGenerations.get(senderId) || 0;
  assert.ok(postGen > pendingLookupGen, 'Post-delete generation must supersede lookups started during pending deletion');
  assert.strictEqual(await Repository.getSenderTimezone(senderId), fallback);
});

test('API Router - /user/timezone persists admin preference and rejects sessions without identity', async () => {
  Repository.resetSenderTimezonesForTesting();

  const getRoute = (apiRouter.stack as any[]).find(
    (layer) => layer.route?.path === '/user/timezone' && layer.route?.methods?.get
  );
  const patchRoute = (apiRouter.stack as any[]).find(
    (layer) => layer.route?.path === '/user/timezone' && layer.route?.methods?.patch
  );
  assert.ok(getRoute, 'Must find GET /user/timezone');
  assert.ok(patchRoute, 'Must find PATCH /user/timezone');

  const invokeGet = async (req: any) => {
    let statusCode = 200;
    let jsonBody: any = null;
    const res: any = {
      status: (c: number) => { statusCode = c; return res; },
      json: (b: any) => { jsonBody = b; },
    };
    await getRoute.route.stack[0].handle(req, res);
    return { status: statusCode, body: jsonBody };
  };

  const invokePatch = async (req: any) => {
    let statusCode = 200;
    let jsonBody: any = null;
    let nextError: any = null;
    const res: any = {
      status: (c: number) => { statusCode = c; return res; },
      json: (b: any) => { jsonBody = b; },
    };
    const next = (err?: any) => { nextError = err; };
    await patchRoute.route.stack[0].handle(req, res, next);
    return { status: statusCode, body: jsonBody, nextError };
  };

  // 1. Session without identity: should be rejected
  const noIdentityRes = await invokePatch({
    vaultUser: { role: 'user' },
    body: { timezone: 'Europe/London' },
  });
  assert.strictEqual(noIdentityRes.status, 400);
  assert.strictEqual(noIdentityRes.body?.error, 'SENDER_ID_REQUIRED');

  // 2. Admin session without senderId: persists under 'admin'
  const adminPatchRes = await invokePatch({
    vaultUser: { role: 'admin' },
    body: { timezone: 'America/New_York' },
  });
  assert.strictEqual(adminPatchRes.status, 200);
  assert.strictEqual(adminPatchRes.body?.success, true);
  assert.strictEqual(adminPatchRes.body?.timezone, 'America/New_York');

  // Subsequent GET for admin session returns saved timezone
  const adminGetRes = await invokeGet({
    vaultUser: { role: 'admin' },
  });
  assert.strictEqual(adminGetRes.status, 200);
  assert.strictEqual(adminGetRes.body?.timezone, 'America/New_York');

  // 3. User session with senderId: persists under senderId
  const userPatchRes = await invokePatch({
    vaultUser: { role: 'user', senderId: 'sender_api_test' },
    body: { timezone: 'Asia/Kolkata' },
  });
  assert.strictEqual(userPatchRes.status, 200);
  assert.strictEqual(userPatchRes.body?.success, true);
  assert.strictEqual(userPatchRes.body?.timezone, 'Asia/Kolkata');

  const userGetRes = await invokeGet({
    vaultUser: { role: 'user', senderId: 'sender_api_test' },
  });
  assert.strictEqual(userGetRes.status, 200);
  assert.strictEqual(userGetRes.body?.timezone, 'Asia/Kolkata');

  // 4. Invalid timezone returns 400
  const invalidPatchRes = await invokePatch({
    vaultUser: { role: 'admin' },
    body: { timezone: 'Invalid/NonExistent_Zone' },
  });
  assert.strictEqual(invalidPatchRes.status, 400);
  assert.strictEqual(invalidPatchRes.body?.error, 'INVALID_TIMEZONE');

  // 5. Database persistence errors are forwarded to Express nextFunction
  const origSet = Repository.setSenderTimezone;
  try {
    Repository.setSenderTimezone = async () => {
      throw new Error('Supabase database connection failed');
    };
    const errRes = await invokePatch({
      vaultUser: { role: 'admin' },
      body: { timezone: 'Europe/Paris' },
    });
    assert.ok(errRes.nextError, 'Persistence error must be passed to Express next');
    assert.strictEqual(errRes.nextError.message, 'Supabase database connection failed');
  } finally {
    Repository.setSenderTimezone = origSet;
  }
});

test('Repository - setSenderTimezone respects deletion barrier and coordinates in-flight writes', async () => {
  Repository.resetSenderTimezonesForTesting();
  Repository.resetDeletionTimestampsForTesting();

  const senderId = 'user_barrier_test';
  await Repository.setSenderTimezone(senderId, 'America/Chicago');
  assert.strictEqual(await Repository.getSenderTimezone(senderId), 'America/Chicago');

  // Trigger deletion
  await Repository.deleteUserDataForSender(senderId);

  // Attempting to set timezone during active deletion barrier window must reject
  await assert.rejects(
    async () => {
      await Repository.setSenderTimezone(senderId, 'Asia/Tokyo');
    },
    (err: any) => err instanceof SenderDeletionBarrierError
  );

  // API router returns 409 DELETION_IN_PROGRESS
  const patchRoute = (apiRouter.stack as any[]).find(
    (layer) => layer.route?.path === '/user/timezone' && layer.route?.methods?.patch
  );
  let status = 200;
  let body: any = null;
  const res: any = {
    status: (c: number) => { status = c; return res; },
    json: (b: any) => { body = b; },
  };
  await patchRoute.route.stack[0].handle(
    { vaultUser: { role: 'user', senderId }, body: { timezone: 'Asia/Tokyo' } },
    res,
    () => {}
  );
  assert.strictEqual(status, 409);
  assert.strictEqual(body?.error, 'DELETION_IN_PROGRESS');
});

test('Repository - tracked write outlasting cooldown cannot recreate deleted preference', async () => {
  Repository.resetSenderTimezonesForTesting();
  Repository.resetDeletionTimestampsForTesting();

  const senderId = 'user_slow_write_barrier';
  await Repository.setSenderTimezone(senderId, 'America/New_York');

  // Simulate an in-flight write for this sender
  let finishInFlight!: () => void;
  const inFlightPromise = new Promise<void>((resolve) => { finishInFlight = resolve; });
  (Repository as any).trackInFlightPreferenceWrite(senderId, inFlightPromise);

  // Start deletion in background (awaits in-flight writes)
  const deletionPromise = Repository.deleteUserDataForSender(senderId);

  // Verify sender is in active deletion
  assert.strictEqual(Repository.isSenderInRecentDeletion(senderId), true);

  // Expire the cooldown timestamp artificially (simulate time passing > 60 seconds)
  (Repository as any).senderDeletionTimestamps.set(senderId, Date.now() - 100_000);

  // Active deletion flag must still keep the barrier closed!
  assert.strictEqual(
    Repository.isSenderInRecentDeletion(senderId),
    true,
    'Barrier must stay active while deletion is in progress even if timestamp expired'
  );

  // setSenderTimezone must still be rejected
  await assert.rejects(
    async () => {
      await Repository.setSenderTimezone(senderId, 'Europe/London');
    },
    (err: any) => err instanceof SenderDeletionBarrierError
  );

  // Release the in-flight write and finish deletion
  finishInFlight();
  await deletionPromise;

  // After deletion completes, the preference is deleted and fresh cooldown window is active
  assert.strictEqual(
    await Repository.getSenderTimezone(senderId),
    process.env.APP_TIMEZONE || process.env.TZ || 'UTC'
  );
  assert.strictEqual(Repository.isSenderInRecentDeletion(senderId), true);
});

test('Repository - overlapping deletions keep barrier active until all deletions finish', async () => {
  Repository.resetSenderTimezonesForTesting();
  Repository.resetDeletionTimestampsForTesting();

  const senderId = 'user_overlapping_deletions';
  await Repository.setSenderTimezone(senderId, 'America/New_York');

  // Simulate overlapping deletions: 2 deletions active concurrently
  (Repository as any).activeSenderDeletions.set(senderId, 2);

  // First deletion finishes, decrementing active count to 1 and setting timestamp
  const remaining = ((Repository as any).activeSenderDeletions.get(senderId) || 1) - 1;
  (Repository as any).activeSenderDeletions.set(senderId, remaining);
  Repository.recordSenderDeletion(senderId);

  // Artificially expire the first deletion's cooldown window (> 60s ago)
  (Repository as any).senderDeletionTimestamps.set(senderId, Date.now() - 100_000);

  // Second deletion is still active (active count = 1), so barrier MUST remain active!
  assert.strictEqual(
    Repository.isSenderInRecentDeletion(senderId),
    true,
    'Barrier must remain active while second deletion is running even after first cooldown expires'
  );

  // setSenderTimezone must reject
  await assert.rejects(
    async () => {
      await Repository.setSenderTimezone(senderId, 'Asia/Kolkata');
    },
    (err: any) => err instanceof SenderDeletionBarrierError
  );

  // Second deletion finishes, clearing active count
  const remaining2 = ((Repository as any).activeSenderDeletions.get(senderId) || 1) - 1;
  if (remaining2 <= 0) {
    (Repository as any).activeSenderDeletions.delete(senderId);
  }
  Repository.recordSenderDeletion(senderId);

  // Now active count is 0 and fresh cooldown is active
  assert.strictEqual(Repository.isSenderInRecentDeletion(senderId), true);
});

test('Targeted Reminder Update Commands - parses creator handles and durations reliably', () => {
  const ref = new Date('2026-11-22T10:00:00.000Z');
  const tz = 'Asia/Kolkata';

  // Pattern 1 & 2 valid variants
  const c1 = parseTargetedReminderUpdateCommand('remind @warnerbrosindia in 2h', ref, tz);
  assert.ok(c1);
  assert.strictEqual(c1.targetCreator, 'warnerbrosindia');
  assert.strictEqual(c1.duration?.seconds, 7200);

  const c2 = parseTargetedReminderUpdateCommand('remind @[warnerbrosindia] 2h', ref, tz);
  assert.ok(c2);
  assert.strictEqual(c2.targetCreator, 'warnerbrosindia');
  assert.strictEqual(c2.duration?.seconds, 7200);

  const c3 = parseTargetedReminderUpdateCommand('remind @<warnerbrosindia> in 2h', ref, tz);
  assert.ok(c3);
  assert.strictEqual(c3.targetCreator, 'warnerbrosindia');

  const c4 = parseTargetedReminderUpdateCommand('remind me about @warnerbrosindia tomorrow at 5pm', ref, tz);
  assert.ok(c4);
  assert.strictEqual(c4.targetCreator, 'warnerbrosindia');
  assert.ok(c4.duration);

  const c5 = parseTargetedReminderUpdateCommand('update reminder for @warnerbrosindia to 2h', ref, tz);
  assert.ok(c5);
  assert.strictEqual(c5.targetCreator, 'warnerbrosindia');
  assert.strictEqual(c5.duration?.seconds, 7200);

  const c6 = parseTargetedReminderUpdateCommand('update @warnerbrosindia 5pm', ref, tz);
  assert.ok(c6);
  assert.strictEqual(c6.targetCreator, 'warnerbrosindia');
  assert.ok(c6.duration);

  const c7 = parseTargetedReminderUpdateCommand('change reminder for @[warnerbrosindia] to 3h', ref, tz);
  assert.ok(c7);
  assert.strictEqual(c7.targetCreator, 'warnerbrosindia');
  assert.strictEqual(c7.duration?.seconds, 10800);

  const c8 = parseTargetedReminderUpdateCommand('snooze @warnerbrosindia 1h', ref, tz);
  assert.ok(c8);
  assert.strictEqual(c8.targetCreator, 'warnerbrosindia');
  assert.strictEqual(c8.duration?.seconds, 3600);

  const c9 = parseTargetedReminderUpdateCommand('snooze @[warnerbrosindia] for 30m', ref, tz);
  assert.ok(c9);
  assert.strictEqual(c9.targetCreator, 'warnerbrosindia');
  assert.strictEqual(c9.duration?.seconds, 1800);

  const c10 = parseTargetedReminderUpdateCommand('snooze 1h for @warnerbrosindia', ref, tz);
  assert.ok(c10);
  assert.strictEqual(c10.targetCreator, 'warnerbrosindia');
  assert.strictEqual(c10.duration?.seconds, 3600);

  const c11 = parseTargetedReminderUpdateCommand('remind in 2h for @warnerbrosindia', ref, tz);
  assert.ok(c11);
  assert.strictEqual(c11.targetCreator, 'warnerbrosindia');
  assert.strictEqual(c11.duration?.seconds, 7200);

  // Untargeted duration expressions must return null so generic duration handler handles them
  assert.strictEqual(parseTargetedReminderUpdateCommand('remind me in 2h', ref, tz), null);
  assert.strictEqual(parseTargetedReminderUpdateCommand('snooze 1h', ref, tz), null);
  assert.strictEqual(parseTargetedReminderUpdateCommand('2h', ref, tz), null);
  assert.strictEqual(parseTargetedReminderUpdateCommand('tomorrow at 5pm', ref, tz), null);

  // Invalid creator target
  const invCreator = parseTargetedReminderUpdateCommand('remind @invalid..handle in 2h', ref, tz);
  assert.ok(invCreator);
  assert.strictEqual(invCreator.invalidCreatorTarget, '@invalid..handle');

  // Invalid duration text
  const invDur = parseTargetedReminderUpdateCommand('update reminder for @warnerbrosindia to non_duration', ref, tz);
  assert.ok(invDur);
  assert.strictEqual(invDur.targetCreator, 'warnerbrosindia');
  assert.strictEqual(invDur.invalidDurationText, 'non_duration');

  // Explicit handle with reserved word name (@done) must be accepted as creator
  const cDone = parseTargetedReminderUpdateCommand('update @done 2h', ref, tz);
  assert.ok(cDone);
  assert.strictEqual(cDone.targetCreator, 'done');
  assert.strictEqual(cDone.duration?.seconds, 7200);

  const cDone2 = parseTargetedReminderUpdateCommand('snooze 2h for @done', ref, tz);
  assert.ok(cDone2);
  assert.strictEqual(cDone2.targetCreator, 'done');

  // Unsigned conversational words and month names must return null
  assert.strictEqual(parseTargetedReminderUpdateCommand('update done 2h', ref, tz), null);
  assert.strictEqual(parseTargetedReminderUpdateCommand('snooze done 1h', ref, tz), null);
  assert.strictEqual(parseTargetedReminderUpdateCommand('remind me november 25', ref, tz), null);
  assert.strictEqual(parseTargetedReminderUpdateCommand('remind me nov 25', ref, tz), null);

  // Explicit @handle for month names must be supported
  const cNov = parseTargetedReminderUpdateCommand('remind @november in 2h', ref, tz);
  assert.ok(cNov);
  assert.strictEqual(cNov.targetCreator, 'november');
  assert.strictEqual(cNov.duration?.seconds, 7200);
});
