import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoundedLines, OutputBatch, intervalMilliseconds, truncateUtf8, MAX_LINE_BYTES } from '../batch.js';

test('batch keeps first 3 and last 20 lines and counts the omitted middle', () => {
  const batch = new OutputBatch();
  for (let i = 1; i <= 30; i++) batch.add(`line ${i}`);
  const out = batch.drain();
  assert.deepEqual(out.slice(0, 3), ['line 1', 'line 2', 'line 3']);
  assert.equal(out[3], '… [7 lines omitted]');
  assert.deepEqual(out.slice(4), Array.from({ length: 20 }, (_, i) => `line ${i + 11}`));
  assert.deepEqual(batch.drain(), [], 'an empty interval stays silent');
});

test('short batches never overlap', () => {
  const batch = new OutputBatch();
  for (const line of ['a', 'b', 'c', 'd']) batch.add(line);
  assert.deepEqual(batch.drain(), ['a', 'b', 'c', 'd']);
});

test('lines are capped at 256 UTF-8 bytes, including multibyte text and unterminated streams', () => {
  const long = 'あ'.repeat(200);
  const cut = truncateUtf8(long);
  assert.ok(Buffer.byteLength(cut) <= MAX_LINE_BYTES);
  assert.ok(cut.endsWith('… [truncated]'));
  const lines = [];
  const reader = new BoundedLines(line => lines.push(line));
  const bytes = Buffer.from('é\nsecond');
  reader.write(bytes.subarray(0, 1));
  reader.write(bytes.subarray(1));
  reader.write('x'.repeat(10_000));
  reader.end();
  assert.equal(lines[0], 'é');
  assert.ok(lines[1].startsWith('secondxxx') && Buffer.byteLength(lines[1]) <= MAX_LINE_BYTES);
});

test('interval defaults to 30 minutes and rejects invalid values', () => {
  assert.equal(intervalMilliseconds(), 1_800_000);
  assert.equal(intervalMilliseconds(0.001), 60);
  assert.throws(() => intervalMilliseconds(0));
  assert.throws(() => intervalMilliseconds(Number.NaN));
});
