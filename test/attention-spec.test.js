const test = require('node:test');
const assert = require('node:assert/strict');
const {
  computeParticipationRates,
  isValidFacePresent,
  isGazeFocused,
  classifyEyesClosedDuration,
  clamp,
} = require('../lib/attentionSpec.js');

test('§6.5 예시: avgAbsent=0.344, gaze/drowsy=0 → 참여율 66', () => {
  const r = computeParticipationRates(0.344, 0, 0);
  assert.equal(r.participationRate, 66);
  assert.ok(Math.abs(r.seatRate - 65.6) < 1e-9);
  assert.equal(r.focusRate, 100);
  assert.equal(r.alertRate, 100);
});

test('§6.4 참여율 클램프: 음수 방지', () => {
  const r = computeParticipationRates(1, 1, 1);
  assert.equal(r.participationRate, 0);
});

test('§6.4 시선·졸음 감점 후 자리 비율 곱', () => {
  const r = computeParticipationRates(0.2, 0.5, 0.25);
  const inner = 100 - 0.5 * 30 - 0.25 * 20;
  assert.equal(inner, 80);
  assert.equal(r.participationRate, Math.round(clamp(80 * (1 - 0.2), 0, 100)));
});

test('§4.2.1 유효 얼굴: confidence·면적·중심', () => {
  assert.equal(
    isValidFacePresent({
      confidence: 0.69,
      cx: 0.5,
      cy: 0.5,
      w: 0.2,
      h: 0.2,
      landmarkOk: true,
    }),
    false,
  );
  assert.equal(
    isValidFacePresent({
      confidence: 0.7,
      cx: 0.5,
      cy: 0.5,
      w: 0.17,
      h: 0.17,
      landmarkOk: true,
    }),
    false,
  );
  assert.equal(
    isValidFacePresent({
      confidence: 0.7,
      cx: 0.5,
      cy: 0.5,
      w: 0.2,
      h: 0.16,
      landmarkOk: true,
    }),
    true,
  );
});

test('§4.3.2 집중 시선 임계', () => {
  assert.equal(isGazeFocused({ yawDeg: 20, pitchDeg: 15, gazeOffsetX: 0.18, gazeOffsetY: 0.2 }), true);
  assert.equal(isGazeFocused({ yawDeg: 20.1, pitchDeg: 0, gazeOffsetX: 0, gazeOffsetY: 0 }), false);
});

test('§4.4.2 폐안 지속 구간', () => {
  assert.equal(classifyEyesClosedDuration(0.09), 'open');
  assert.equal(classifyEyesClosedDuration(0.25), 'blink');
  assert.equal(classifyEyesClosedDuration(1.0),  'between_blink_and_warning');
  assert.equal(classifyEyesClosedDuration(5.0),  'micro_sleep_warning');
  assert.equal(classifyEyesClosedDuration(10.0), 'micro_sleep_risk');
});
