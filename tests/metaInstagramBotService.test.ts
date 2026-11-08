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
  assert.strictEqual(extractCreatorQuery('reels by @_docthor_'), '_docthor_');
  assert.strictEqual(extractCreatorQuery('reels from _docthor_'), '_docthor_');
  assert.strictEqual(extractCreatorQuery('_docthor_'), '_docthor_');
  assert.strictEqual(extractCreatorQuery('hello'), null);
  assert.strictEqual(extractCreatorQuery('watched'), null);
});
