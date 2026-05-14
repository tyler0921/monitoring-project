/**
 * ATTENTION_MONITORING_REDESIGN.md — 브라우저용 ESM (lib/attentionSpec.js 와 동일 규칙).
 */

/** @param {number} x @param {number} lo @param {number} hi */
export function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * §6.3 보조 지표 및 §6.4 최종 참여율.
 * @param {number} avgAbsent
 * @param {number} avgGaze
 * @param {number} avgDrowsy
 */
export function computeParticipationRates(avgAbsent, avgGaze, avgDrowsy) {
  const seatRate = (1 - avgAbsent) * 100;
  const focusRate = Math.max(0, 100 - avgGaze * 30);
  const alertRate = Math.max(0, 100 - avgDrowsy * 20);
  const participationRate = Math.round(
    clamp((100 - avgGaze * 30 - avgDrowsy * 20) * (1 - avgAbsent), 0, 100),
  );
  return { seatRate, focusRate, alertRate, participationRate };
}

/** @param {{ confidence: number, cx: number, cy: number, w: number, h: number, landmarkOk: boolean }} p */
export function isValidFacePresent(p) {
  if (!p.landmarkOk) return false;
  if (p.confidence < 0.7) return false;
  if (p.cx < 0 || p.cx > 1 || p.cy < 0 || p.cy > 1) return false;
  if (p.w * p.h < 0.03) return false;
  return true;
}

/** @param {{ yawDeg: number, pitchDeg: number, gazeOffsetX: number, gazeOffsetY: number }} g */
export function isGazeFocused(g) {
  return (
    Math.abs(g.yawDeg) <= 20 &&
    Math.abs(g.pitchDeg) <= 15 &&
    Math.abs(g.gazeOffsetX) <= 0.18 &&
    Math.abs(g.gazeOffsetY) <= 0.2
  );
}

/** @param {number} durationSec */
export function classifyEyesClosedDuration(durationSec) {
  if (durationSec < 0.1) return 'open';
  if (durationSec <= 0.4) return 'blink';
  if (durationSec < 3) return 'between_blink_and_warning';
  if (durationSec < 10) return 'micro_sleep_warning';
  return 'micro_sleep_risk';
}
