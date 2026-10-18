/**
 * Checks for the panel font sync.
 *
 * The rule: follow the Host's chat text relatively (zoom or a bigger chat font
 * both count), keep the panel inside a readable range, and let the in-panel
 * shortcut nudge the result without escaping its own bounds.
 *
 * Run: node scripts/font-scale-check.mjs
 */
import assert from 'node:assert/strict';
import {
  FALLBACK_PX,
  MAX_PX,
  MAX_USER_SCALE,
  MIN_PX,
  MIN_USER_SCALE,
  USER_SCALE_STEP,
  fontTargetOf,
  nextUserScale,
  pxOf,
} from '../lib/web/font-scale.js';

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

check('a missing measurement falls back to the panel base', () => {
  assert.equal(fontTargetOf({ parentPx: null }), FALLBACK_PX);
  assert.equal(fontTargetOf({ parentPx: 0 }), FALLBACK_PX);
  assert.equal(fontTargetOf({ parentPx: 18, baselinePx: 18 }), FALLBACK_PX);
});

check('at the captured baseline the panel keeps its own size', () => {
  assert.equal(fontTargetOf({ parentPx: 18, baselinePx: 18 }), 13);
  assert.equal(fontTargetOf({ parentPx: 16, baselinePx: 16 }), 13);
});

check('a zoom step moves the panel by the same factor', () => {
  assert.equal(fontTargetOf({ parentPx: 22.5, baselinePx: 18 }), 16.5);
  assert.equal(fontTargetOf({ parentPx: 14.4, baselinePx: 18 }), 10.5);
});


check('results stay inside the readable range', () => {
  for (const parentPx of [1, 6, 18, 40, 200]) {
    const value = fontTargetOf({ parentPx, baselinePx: 18 });
    assert.ok(value >= MIN_PX && value <= MAX_PX, `${parentPx} → ${value}`);
  }
});

check('the user multiplier applies on top of the Host ratio', () => {
  assert.equal(fontTargetOf({ parentPx: 18, baselinePx: 18, userScale: 1.2 }), 15.5);
  assert.equal(fontTargetOf({ parentPx: 22.5, baselinePx: 18, userScale: 0.8 }), 13);
});

check('an out-of-range multiplier is clamped', () => {
  assert.equal(fontTargetOf({ parentPx: 18, baselinePx: 18, userScale: 9 }), fontTargetOf({ parentPx: 18, baselinePx: 18, userScale: MAX_USER_SCALE }));
  assert.equal(fontTargetOf({ parentPx: 18, baselinePx: 18, userScale: 0.01 }), fontTargetOf({ parentPx: 18, baselinePx: 18, userScale: MIN_USER_SCALE }));
});

check('half-pixel snapping keeps zoom noise from thrashing', () => {
  assert.equal(fontTargetOf({ parentPx: 18.4, baselinePx: 18 }), 13.5);
  assert.equal(fontTargetOf({ parentPx: 17.6, baselinePx: 18 }), 12.5);
});

check('one press steps the multiplier and stops at the bounds', () => {
  assert.equal(nextUserScale('in', 1), 1.1);
  assert.equal(nextUserScale('out', 1), 0.9);
  assert.equal(nextUserScale('in', MAX_USER_SCALE), MAX_USER_SCALE);
  assert.equal(nextUserScale('out', MIN_USER_SCALE), MIN_USER_SCALE);
  assert.equal(nextUserScale('reset', 1.4), 1);
  assert.equal(nextUserScale('in'), 1 + USER_SCALE_STEP);
});

check('px parsing accepts computed sizes and rejects the rest', () => {
  assert.equal(pxOf('18px'), 18);
  assert.equal(pxOf('13.5px'), 13.5);
  assert.equal(pxOf('1em'), null);
  assert.equal(pxOf(''), null);
  assert.equal(pxOf(undefined), null);
  assert.equal(pxOf('0px'), null);
});

console.log(failures === 0 ? '\nfont scale checks passed' : `\n${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
