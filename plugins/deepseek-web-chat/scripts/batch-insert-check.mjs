/**
 * Checks for batch insertion: ordering, numbering, separators and the two
 * limits. `joinAnswers` is pure, so this needs no DOM at all.
 *
 * Run: node scripts/batch-insert-check.mjs
 */
import assert from 'node:assert/strict';
import { BATCH_LIMITS, joinAnswers, withSourceMarker } from '../lib/web/composer-bridge.js';

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

const separator = BATCH_LIMITS.separator;

await check('three answers are joined in order with separators and numbering', async () => {
  const result = joinAnswers(
    [
      { text: 'first', at: 0 },
      { text: 'second', at: 1 },
      { text: 'third', at: 2 },
    ],
    { lang: 'zh', marker: true },
  );
  assert.equal(result.count, 3);
  assert.equal(
    result.text,
    [
      '> 来自 DeepSeek Chat · 第 1 条\n\nfirst',
      '> 来自 DeepSeek Chat · 第 2 条\n\nsecond',
      '> 来自 DeepSeek Chat · 第 3 条\n\nthird',
    ].join(separator),
  );
  assert.equal(result.text.split(separator).length, 3);
  assert.equal(result.overLimit, false);
  assert.equal(result.reasons.length, 0);
});

await check('shuffled input is still emitted chronologically', async () => {
  const result = joinAnswers(
    [
      { text: 'third', at: 30 },
      { text: 'first', at: 10 },
      { text: 'second', at: 20 },
    ],
    { lang: 'zh', marker: true },
  );
  const bodies = result.text.split(separator).map((chunk) => chunk.split('\n\n').at(-1));
  assert.deepEqual(bodies, ['first', 'second', 'third']);
  assert.match(result.text, /第 1 条\n\nfirst/u);
});

await check('numbers keep the chronological position even when markers are off', async () => {
  const withMarkers = joinAnswers([{ text: 'a', at: 2 }, { text: 'b', at: 1 }], { lang: 'zh', marker: true });
  assert.match(withMarkers.text, /第 1 条\n\nb/u);
  const withoutMarkers = joinAnswers([{ text: 'a', at: 2 }, { text: 'b', at: 1 }], { lang: 'zh', marker: false });
  assert.equal(withoutMarkers.text, `b${separator}a`);
});

await check('English markers use the # form', async () => {
  const result = joinAnswers([{ text: 'answer', at: 0 }], { lang: 'en', marker: true });
  assert.equal(result.text, '> From DeepSeek Chat · #1\n\nanswer');
});

await check('a single answer degrades to the plain single-insert payload', async () => {
  const result = joinAnswers([{ text: 'only one', at: 0 }], { lang: 'zh', marker: false });
  assert.equal(result.text, 'only one');
  assert.equal(result.text.includes('---'), false);
  const marked = joinAnswers([{ text: 'only one', at: 0 }], { lang: 'zh', marker: true });
  assert.equal(marked.text, withSourceMarker('only one', 'zh', true, 1));
  assert.match(marked.text, /第 1 条/u);
});

await check('more than eight answers reports the count limit', async () => {
  const answers = Array.from({ length: 9 }, (_, index) => ({ text: `answer ${index}`, at: index }));
  const result = joinAnswers(answers, { lang: 'zh' });
  assert.equal(result.count, 9);
  assert.equal(result.overLimit, true);
  assert.deepEqual(result.reasons, ['count']);
  // Nothing is truncated: every answer is still present.
  assert.equal(result.text.split(separator).length, 9);
});

await check('eight answers are still allowed', async () => {
  const answers = Array.from({ length: 8 }, (_, index) => ({ text: 'x', at: index }));
  const result = joinAnswers(answers, { lang: 'zh' });
  assert.equal(result.overLimit, false);
});

await check('a batch over 20000 characters reports the size limit', async () => {
  const big = 'y'.repeat(BATCH_LIMITS.maxChars);
  const result = joinAnswers([{ text: big, at: 0 }, { text: 'tail', at: 1 }], { lang: 'zh' });
  assert.equal(result.chars > BATCH_LIMITS.maxChars, true);
  assert.equal(result.overLimit, true);
  assert.deepEqual(result.reasons, ['chars']);
  assert.equal(result.text.includes('tail'), true, 'the tail must not be dropped');
});

await check('both limits together report both reasons', async () => {
  const answers = Array.from({ length: 10 }, (_, index) => ({ text: 'z'.repeat(3000), at: index }));
  const result = joinAnswers(answers, { lang: 'zh' });
  assert.deepEqual(result.reasons.sort(), ['chars', 'count']);
});

await check('empty input is handled without throwing', async () => {
  const result = joinAnswers([], { lang: 'zh' });
  assert.equal(result.count, 0);
  assert.equal(result.text, '');
  assert.equal(result.overLimit, false);
});

await check('missing text fields become empty strings, not undefined', async () => {
  const result = joinAnswers([{ at: 0 }, { text: 'second', at: 1 }], { lang: 'zh', marker: false });
  assert.equal(result.text, `${separator}second`);
});

console.log(failures === 0 ? '\nbatch insert checks passed' : `\n${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
