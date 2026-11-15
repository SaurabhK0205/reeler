import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration, formatTargetTime } from '../src/utils/duration.ts';

test('Duration & Timezone - formats target times in Asia/Kolkata (IST)', () => {
  const originalTZ = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Kolkata';

    // 16:29:49 UTC is 21:59:49 IST (9:59 PM)
    const now = new Date('2026-11-15T16:29:49.000Z');
    // 30 seconds later: 16:30:19 UTC is 22:00:19 IST (10:00 PM)
    const target30s = new Date('2026-11-15T16:30:19.000Z');

    const formatted30s = formatTargetTime(target30s, now);
    assert.strictEqual(formatted30s, 'today at 10:00:19 PM');

    // 10 hours later: 02:29:49 UTC next day is 07:59:49 IST (7:59 AM next morning)
    const target10h = new Date('2026-11-16T02:29:49.000Z');
    const formatted10h = formatTargetTime(target10h, now);
    assert.strictEqual(formatted10h, 'tomorrow at 7:59 AM');
  } finally {
    process.env.TZ = originalTZ;
  }
});

test('Duration & Timezone - parses natural language times under Asia/Kolkata', () => {
  const originalTZ = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Kolkata';

    // Sunday Nov 15 2026 at 9:59 PM IST (16:29:49 UTC)
    const now = new Date('2026-11-15T16:29:49.000Z');

    // "tomorrow at 5pm" -> Monday Nov 16 at 17:00 IST -> 11:30 UTC
    const parsedTomorrow5pm = parseDuration('tomorrow at 5pm', now);
    assert.ok(parsedTomorrow5pm);
    assert.strictEqual(parsedTomorrow5pm.targetDate.toISOString(), '2026-11-16T11:30:00.000Z');
    assert.strictEqual(parsedTomorrow5pm.formattedTarget, 'tomorrow at 5:00 PM');

    // Relative duration "30 seconds"
    const parsed30s = parseDuration('30 seconds', now);
    assert.ok(parsed30s);
    assert.strictEqual(parsed30s.seconds, 30);
    assert.strictEqual(parsed30s.formattedTarget, 'today at 10:00:19 PM');
  } finally {
    process.env.TZ = originalTZ;
  }
});
