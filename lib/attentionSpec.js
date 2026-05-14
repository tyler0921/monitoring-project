/**
 * ATTENTION_MONITORING_REDESIGN.md 기준 정량 규칙(순수 함수).
 * 브라우저/서버 어디서든 동일 산식을 쓰도록 분리한다.
 */

/** @param {number} x @param {number} lo @param {number} hi */
function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * §6.3 보조 지표 및 §6.4 최종 참여율.
 *
 * @param {number} avgAbsent 0~1
 * @param {number} avgGaze 0~1
 * @param {number} avgDrowsy 0~1
 * @returns {{
 *   seatRate: number,
 *   focusRate: number,
 *   alertRate: number,
 *   participationRate: number
 * }}
 */
function computeParticipationRates(avgAbsent, avgGaze, avgDrowsy) {
  const seatRate = (1 - avgAbsent) * 100;
  const focusRate = Math.max(0, 100 - avgGaze * 30);
  const alertRate = Math.max(0, 100 - avgDrowsy * 20);
  const participationRate = Math.round(
    clamp((100 - avgGaze * 30 - avgDrowsy * 20) * (1 - avgAbsent), 0, 100),
  );
  return { seatRate, focusRate, alertRate, participationRate };
}

/**
 * §4.2.1 유효 얼굴(facePresent) 조건.
 *
 * @param {{
 *   confidence: number,
 *   cx: number,
 *   cy: number,
 *   w: number,
 *   h: number,
 *   landmarkOk: boolean
 * }} p
 * @returns {boolean}
 */
function isValidFacePresent(p) {
  if (!p.landmarkOk) return false;
  if (p.confidence < 0.7) return false;
  if (p.cx < 0 || p.cx > 1 || p.cy < 0 || p.cy > 1) return false;
  if (p.w * p.h < 0.03) return false;
  return true;
}

/**
 * §4.3.2 집중(focused) 시선·머리 기준.
 *
 * @param {{
 *   yawDeg: number,
 *   pitchDeg: number,
 *   gazeOffsetX: number,
 *   gazeOffsetY: number
 * }} g
 * @returns {boolean}
 */
function isGazeFocused(g) {
  return (
    Math.abs(g.yawDeg) <= 20 &&
    Math.abs(g.pitchDeg) <= 15 &&
    Math.abs(g.gazeOffsetX) <= 0.18 &&
    Math.abs(g.gazeOffsetY) <= 0.2
  );
}

/**
 * §4.4.2 EAR<0.21 구간이 주어진 지속시간(초)일 때 상태 구간 분류.
 * 문서에 이름 없는 구간(0.40~1.5초)은 `between_blink_and_warning` 으로 둔다.
 *
 * @param {number} durationSec
 * @returns {'open'|'blink'|'between_blink_and_warning'|'micro_sleep_warning'|'micro_sleep_risk'}
 */
function classifyEyesClosedDuration(durationSec) {
  if (durationSec < 0.1) return 'open';
  if (durationSec <= 0.4) return 'blink';
  if (durationSec < 3) return 'between_blink_and_warning';
  if (durationSec < 10) return 'micro_sleep_warning';
  return 'micro_sleep_risk';
}

module.exports = {
  clamp,
  computeParticipationRates,
  isValidFacePresent,
  isGazeFocused,
  classifyEyesClosedDuration,
};
