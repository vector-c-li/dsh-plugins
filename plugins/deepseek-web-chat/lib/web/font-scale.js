/**
 * Keep the panel's text in step with the DSH conversation it sits next to.
 *
 * The panel is a same-origin iframe, so the Host's computed styles are readable.
 * "In step" means the same *scale*, not the same absolute pixels: the Host's chat
 * font size at 100% is captured as a baseline on first load, and every later
 * measurement is expressed as a ratio against it. A zoom step or a bigger chat
 * font therefore moves the panel by exactly the same factor, while the panel keeps
 * its own (denser) default size.
 *
 * The user's own preference multiplies on top (Ctrl/Cmd + `+` / `-` / `0` inside
 * the panel), so a panel can be nudged without fighting the Host.
 *
 * @module deepseek-web-chat/font-scale
 */

/** Smallest root font size the panel will render at. */
export const MIN_PX = 10;
/** Largest root font size the panel will render at. */
export const MAX_PX = 22;
/** The panel's own default root size when the Host cannot be measured. */
export const FALLBACK_PX = 13;
/** Multiplier range for the in-panel shortcut. */
export const MIN_USER_SCALE = 0.8;
export const MAX_USER_SCALE = 1.6;
/** One shortcut press changes the multiplier by this much. */
export const USER_SCALE_STEP = 0.1;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/** Snap to half pixels so sub-pixel noise from zoom does not thrash the DOM. */
function roundHalf(value) {
  return Math.round(value * 2) / 2;
}

/**
 * Root font size for the panel.
 * @param {object} options
 * @param {number|null} options.parentPx Measured Host chat font size.
 * @param {number|null} [options.baselinePx] Host size at 100%, captured earlier.
 * @param {number} [options.userScale] In-panel multiplier.
 * @param {number} [options.basePx] The panel's own default root size.
 * @returns {number} Root font size in px, rounded to half a pixel.
 */
export function fontTargetOf({ parentPx, baselinePx, userScale = 1, basePx = FALLBACK_PX }) {
  const scale = Number.isFinite(userScale) ? clamp(userScale, MIN_USER_SCALE, MAX_USER_SCALE) : 1;
  if (!Number.isFinite(parentPx) || parentPx <= 0) return roundHalf(clamp(basePx * scale, MIN_PX, MAX_PX));
  const baseline = Number.isFinite(baselinePx) && baselinePx > 0 ? baselinePx : parentPx;
  const ratio = parentPx / baseline;
  return roundHalf(clamp(basePx * ratio * scale, MIN_PX, MAX_PX));
}

/**
 * New multiplier for one shortcut press.
 * @param {'in'|'out'|'reset'} action
 * @param {number} current
 */
export function nextUserScale(action, current = 1) {
  if (action === 'reset') return 1;
  const delta = action === 'in' ? USER_SCALE_STEP : -USER_SCALE_STEP;
  const value = clamp((Number.isFinite(current) ? current : 1) + delta, MIN_USER_SCALE, MAX_USER_SCALE);
  return Math.round(value * 100) / 100;
}

/**
 * Read a font size from a computed style string such as `18px`.
 * @param {string|null|undefined} value
 * @returns {number|null}
 */
export function pxOf(value) {
  if (typeof value !== 'string') return null;
  const match = /^([\d.]+)px$/u.exec(value.trim());
  if (match === null) return null;
  const number = Number(match[1]);
  return Number.isFinite(number) && number > 0 ? number : null;
}
