/**
 * 수강생 추적 — ATTENTION_MONITORING_REDESIGN.md 기준
 * MediaPipe Tasks Vision Face Landmarker (브라우저 추론 5 FPS).
 */
import { FaceLandmarker, FilesetResolver } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm';
import {
  computeParticipationRates,
  isValidFacePresent,
  isGazeFocused,
  classifyEyesClosedDuration,
} from './attentionSpec.js';

const MP_WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MP_MODEL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

let faceLandmarker = null;

const SAMPLE_MS = 200;
const WINDOW_1S = 5;
const ABSENT_MS = 5000;
const WARN_MISSING_MS = 1000;
const LOOK_SHORT_MS = 2000;
const LOOK_LONG_MS = 5000;
const NOTE_PITCH = -20;
const NOTE_GRACE_MS = 3000;
const SMOOTH_N = 10;
const PART_RING = 300;

/** 우안(화면 왼쪽) · 좌안(화면 오른쪽) EAR 6점 */
const RIGHT_EYE_IDX = [33, 159, 158, 133, 153, 145];
const LEFT_EYE_IDX = [362, 385, 387, 263, 373, 380];

let socket = null;
let running = false;
let sessStart = null;
let absStart = null;
let absLogs = [];
let totalAbsMs = 0;
let isAbsent = false;
let thrSec = 20;
let detInt = null;
let tickInt = null;
let tsInt = null;
let paused = false;
let lastSentStatus = null;

let consecutiveValid = 0;
let noFaceMs = 0;
let validFaceBuf = [];

let gazeSmoothBuf = [];
let pitchDownMs = 0;
let lookAwayStrictMs = 0;
let earBelowMs = 0;
let prevUiStatus = 'idle';
let statusStart = null;

let partRing = [];
let lastPartDisplay = 100;

const vid = document.getElementById('vid');
const cvs = document.getElementById('cvs');
const ctx = cvs.getContext('2d');

function fms(ms) {
  if (!ms || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}분 ${String(s % 60).padStart(2, '0')}초` : `${s}초`;
}
function ft(ts) {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((v) => String(v).padStart(2, '0')).join(':');
}

function dist2(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** @param {import('@mediapipe/tasks-vision').NormalizedLandmark[]} lm */
function earOneSide(lm, idx) {
  const p = idx.map((i) => lm[i]);
  const v1 = dist2(p[1], p[5]);
  const v2 = dist2(p[2], p[4]);
  const h = dist2(p[0], p[3]);
  return h < 1e-6 ? 0.3 : (v1 + v2) / (2 * h);
}

/** @param {import('@mediapipe/tasks-vision').NormalizedLandmark[]} lm */
function computeAvgEar(lm) {
  if (!lm || lm.length < 400) return 0.28;
  return (earOneSide(lm, LEFT_EYE_IDX) + earOneSide(lm, RIGHT_EYE_IDX)) / 2;
}

/**
 * 홍채 중심(468,473)과 눈 가로폭 대비 시선 편차(문서 §4.3 스케일에 맞게 축소).
 * @param {import('@mediapipe/tasks-vision').NormalizedLandmark[]} lm
 */
function computeGazeOffsets(lm) {
  if (!lm || lm.length < 474) return { gazeOffsetX: 0, gazeOffsetY: 0 };
  const L_OUT = lm[33];
  const L_INN = lm[133];
  const R_INN = lm[362];
  const R_OUT = lm[263];
  const iL = lm[468];
  const iR = lm[473];
  const lw = Math.abs(L_INN.x - L_OUT.x) + 1e-4;
  const rw = Math.abs(R_OUT.x - R_INN.x) + 1e-4;
  const lx = (iL.x - (L_OUT.x + L_INN.x) / 2) / lw;
  const rx = (iR.x - (R_OUT.x + R_INN.x) / 2) / rw;
  const gazeOffsetX = ((lx + rx) / 2) * 0.35;
  const ly = (iL.y - (L_OUT.y + L_INN.y) / 2) / lw;
  const ry = (iR.y - (R_OUT.y + R_INN.y) / 2) / rw;
  const gazeOffsetY = ((ly + ry) / 2) * 0.35;
  return { gazeOffsetX, gazeOffsetY };
}

/**
 * 머리 각도(도). 변환 행렬이 유효하면 사용, 이상하면 랜드마크 추정.
 * @param {object[]} lm
 * @param {Float32Array | undefined} m16
 */
function computeHeadDeg(lm, m16) {
  function fromLm() {
    const nose = lm[1];
    const lEye = lm[33];
    const rEye = lm[263];
    const eyeMidX = (lEye.x + rEye.x) / 2;
    const eyeMidY = (lEye.y + rEye.y) / 2;
    const eyeW = Math.hypot(lEye.x - rEye.x, lEye.y - rEye.y) + 1e-4;
    const yawDeg = clampNum((Math.atan2(nose.x - eyeMidX, eyeW * 0.6) * 180) / Math.PI, -90, 90);
    const noseRelY = (nose.y - eyeMidY) / eyeW;
    const pitchDeg = clampNum((noseRelY - 0.28) * 150, -90, 90);
    return { yawDeg, pitchDeg, rollDeg: 0 };
  }
  if (m16 && m16.length >= 16) {
    const r02 = m16[2];
    const r12 = m16[6];
    const r22 = m16[10];
    const r10 = m16[4];
    const r11 = m16[5];
    const yawDeg = (Math.atan2(r02, r22) * 180) / Math.PI;
    const pitchDeg = (Math.asin(clampNum(-r12, -1, 1)) * 180) / Math.PI;
    const rollDeg = (Math.atan2(r10, r11) * 180) / Math.PI;
    if (
      Number.isFinite(yawDeg) &&
      Number.isFinite(pitchDeg) &&
      Math.abs(yawDeg) < 80 &&
      Math.abs(pitchDeg) < 80
    ) {
      return { yawDeg, pitchDeg, rollDeg };
    }
  }
  return fromLm();
}

function clampNum(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

/** @param {import('@mediapipe/tasks-vision').NormalizedLandmark[]} lm */
function bboxFromLandmarks(lm) {
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  for (const p of lm) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const w = maxX - minX;
  const h = maxY - minY;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return { cx, cy, w, h };
}

/** @param {import('@mediapipe/tasks-vision').NormalizedLandmark[]} lm */
function landmarkVisibilityAvg(lm) {
  // Face Landmarker는 visibility를 항상 0.0으로 반환 → 0이면 0.88로 대체
  let s = 0;
  let n = 0;
  for (const p of lm) {
    if (typeof p.visibility === 'number') {
      s += p.visibility;
      n++;
    }
  }
  return n > 0 ? (s / n || 0.88) : 0.88;
}

function pushSmooth(buf, sample, cap) {
  buf.push(sample);
  if (buf.length > cap) buf.shift();
  return buf;
}

function meanBuf(buf, key) {
  if (!buf.length) return 0;
  let s = 0;
  for (const o of buf) s += o[key];
  return s / buf.length;
}

function setStatus(st) {
  const spill = document.getElementById('spill');
  const m = {
    present: ['sp-p', 'PRESENT'],
    warning: ['sp-w', 'WARNING'],
    absent: ['sp-a', 'ABSENT'],
    idle: ['sp-i', 'IDLE'],
    look_away_short: ['sp-w', '시선↓'],
    look_away_long: ['sp-w', '시선이탈'],
    drowsy_risk: ['sp-a', '졸음위험'],
  };
  const [cl, tx] = m[st] || m.idle;
  spill.className = `status-pill ${cl}`;
  spill.textContent = tx;
}

function setConn(st) {
  const dot = document.getElementById('conn-dot');
  const lbl = document.getElementById('conn-lbl');
  const m = { ok: ['ok', '연결됨'], err: ['err', '연결 끊김'], connecting: ['', '연결 중'] };
  const [cls, tx] = m[st] || m.connecting;
  dot.className = `conn-dot ${cls}`;
  lbl.textContent = tx;
}

function addLog(entry) {
  document.getElementById('log-empty')?.remove();
  const r = document.createElement('div');
  r.className = 'log-row';
  const tag = entry.tag ? `<span class="lm">[${entry.tag}]</span>` : '';
  r.innerHTML = `<span class="lt">${ft(entry.s)} → ${ft(entry.e)}</span>${tag}<span class="ld">${fms(entry.d)}</span>`;
  document.getElementById('log-body').insertBefore(r, document.getElementById('log-body').firstChild);
}

function emitStatus(status, force = false, coords = null, meta = null) {
  if (!force && lastSentStatus === status) return;
  const payload = { status };
  if (coords) payload.coords = coords;
  if (meta) payload.meta = meta;
  socket?.emit('status', payload);
  lastSentStatus = status;
}

function extractCoordsFromBbox(cx, cy, w, h, score01) {
  return {
    cx: +cx.toFixed(3),
    cy: +cy.toFixed(3),
    w: +w.toFixed(3),
    h: +h.toFixed(3),
    score: Math.round(score01 * 100),
  };
}

function pushPartSample(absI, gazeI, drowsyI) {
  partRing.push({ a: absI, g: gazeI, d: drowsyI });
  if (partRing.length > PART_RING) partRing.shift();
}

function rollingParticipation() {
  if (!partRing.length) return lastPartDisplay;
  const n = partRing.length;
  let sa = 0;
  let sg = 0;
  let sd = 0;
  for (const o of partRing) {
    sa += o.a;
    sg += o.g;
    sd += o.d;
  }
  const { participationRate } = computeParticipationRates(sa / n, sg / n, sd / n);
  return participationRate;
}

function drawFaceBox(coords, uiStatus) {
  ctx.clearRect(0, 0, cvs.width, cvs.height);
  if (!coords) return;
  const sx = cvs.width / (vid.videoWidth || cvs.width);
  const sy = cvs.height / (vid.videoHeight || cvs.height);
  const x = coords.cx * (vid.videoWidth || 1) * sx - (coords.w * (vid.videoWidth || 1) * sx) / 2;
  const y = coords.cy * (vid.videoHeight || 1) * sy - (coords.h * (vid.videoHeight || 1) * sy) / 2;
  const bw = coords.w * (vid.videoWidth || 1) * sx;
  const bh = coords.h * (vid.videoHeight || 1) * sy;
  const col =
    uiStatus === 'absent'
      ? '#ff4d4d'
      : uiStatus === 'drowsy_risk' || uiStatus === 'look_away_long'
        ? '#f5a623'
        : uiStatus === 'warning' || uiStatus === 'look_away_short'
          ? '#f5a623'
          : '#00e5a0';
  ctx.strokeStyle = col;
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, bw, bh);
}

async function createLandmarker() {
  const vision = await FilesetResolver.forVisionTasks(MP_WASM);
  const base = {
    modelAssetPath: MP_MODEL,
    delegate: 'GPU',
  };
  const opts = (del) => ({
    baseOptions: { ...base, delegate: del },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFaceBlendshapes: false,
    outputFacialTransformationMatrixes: true,
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.55,
  });
  try {
    return await FaceLandmarker.createFromOptions(vision, opts('GPU'));
  } catch (e) {
    console.warn('GPU delegate 실패, CPU로 재시도', e);
    return await FaceLandmarker.createFromOptions(vision, opts('CPU'));
  }
}

function detectFrame() {
  if (!running || paused || !faceLandmarker || !vid.videoWidth) return;

  let res;
  try {
    res = faceLandmarker.detectForVideo(vid, performance.now());
  } catch (e) {
    console.warn('detectForVideo 오류:', e);
    return;
  }
  const lm0 = res.faceLandmarks?.[0];
  let validFace = false;
  let coords = null;
  let yawDeg = 0;
  let pitchDeg = 0;
  let gazeOffsetX = 0;
  let gazeOffsetY = 0;
  let avgEar = 0.28;
  let conf = 0.75;

  if (lm0 && lm0.length > 100) {
    const { cx, cy, w, h } = bboxFromLandmarks(lm0);
    conf = landmarkVisibilityAvg(lm0);
    const landmarkOk = true;
    validFace = isValidFacePresent({ confidence: conf, cx, cy, w, h, landmarkOk });
    coords = extractCoordsFromBbox(cx, cy, w, h, conf);
    const m = res.facialTransformationMatrixes?.[0];
    const flat = m?.data?.length >= 16 ? m.data : undefined;
    const head = computeHeadDeg(lm0, flat);
    yawDeg = head.yawDeg;
    pitchDeg = head.pitchDeg;
    const go = computeGazeOffsets(lm0);
    gazeOffsetX = go.gazeOffsetX;
    gazeOffsetY = go.gazeOffsetY;
    avgEar = computeAvgEar(lm0);
  }

  validFaceBuf.push(validFace ? 1 : 0);
  if (validFaceBuf.length > WINDOW_1S) validFaceBuf.shift();
  const validRatio = validFaceBuf.reduce((a, b) => a + b, 0) / validFaceBuf.length;

  if (validFace) {
    consecutiveValid++;
    noFaceMs = 0;
  } else {
    consecutiveValid = 0;
    noFaceMs += SAMPLE_MS;
  }

  gazeSmoothBuf = pushSmooth(
    gazeSmoothBuf,
    { yawDeg, pitchDeg, gazeOffsetX, gazeOffsetY },
    SMOOTH_N,
  );
  const yawS = meanBuf(gazeSmoothBuf, 'yawDeg');
  const pitchS = meanBuf(gazeSmoothBuf, 'pitchDeg');
  const gxS = meanBuf(gazeSmoothBuf, 'gazeOffsetX');
  const gyS = meanBuf(gazeSmoothBuf, 'gazeOffsetY');

  if (pitchS < NOTE_PITCH) pitchDownMs += SAMPLE_MS;
  else pitchDownMs = 0;

  const noteExempt = pitchS < NOTE_PITCH && pitchDownMs < NOTE_GRACE_MS;
  const focused = isGazeFocused({ yawDeg: yawS, pitchDeg: pitchS, gazeOffsetX: gxS, gazeOffsetY: gyS });
  if (!focused && !noteExempt) lookAwayStrictMs += SAMPLE_MS;
  else lookAwayStrictMs = 0;

  if (avgEar < 0.21) earBelowMs += SAMPLE_MS;
  else earBelowMs = 0;

  const earSec = earBelowMs / 1000;
  const earClass = classifyEyesClosedDuration(earSec);

  let seatTier = 'present';
  if (isAbsent) {
    if (consecutiveValid >= 2 || validRatio >= 0.6) seatTier = 'present';
    else seatTier = 'absent';
  } else if (noFaceMs >= ABSENT_MS) seatTier = 'absent';
  else if (noFaceMs >= WARN_MISSING_MS || (validRatio >= 0.2 && validRatio < 0.6) || validRatio < 0.2)
    seatTier = 'warning';
  else seatTier = 'present';

  if (seatTier === 'absent' && !isAbsent) {
    isAbsent = true;
    absStart = Date.now();
  } else if (seatTier === 'present' && isAbsent) {
    const s0 = absStart;
    const e0 = Date.now();
    const dur = e0 - s0;
    isAbsent = false;
    absLogs.push({ s: s0, e: e0, d: dur, tag: '자리' });
    totalAbsMs += dur;
    absStart = null;
    noFaceMs = 0;
  }

  let uiStatus = 'present';
  if (isAbsent) uiStatus = 'absent';
  else if (earClass === 'micro_sleep_risk') uiStatus = 'drowsy_risk';
  else if (lookAwayStrictMs >= LOOK_LONG_MS) uiStatus = 'look_away_long';
  else if (lookAwayStrictMs >= LOOK_SHORT_MS || earClass === 'micro_sleep_warning') uiStatus = 'look_away_short';
  else if (seatTier === 'warning') uiStatus = 'warning';
  else uiStatus = 'present';

  if (uiStatus !== prevUiStatus) {
    const now = Date.now();
    const LOG_TAG = {
      absent: '자리이탈', warning: '경고',
      look_away_short: '시선↓', look_away_long: '시선이탈', drowsy_risk: '졸음위험',
    };
    if (LOG_TAG[prevUiStatus] && statusStart) {
      addLog({ s: statusStart, e: now, d: now - statusStart, tag: LOG_TAG[prevUiStatus] });
    }
    statusStart = LOG_TAG[uiStatus] ? now : null;
    prevUiStatus = uiStatus;
  }

  const absI = uiStatus === 'absent' ? 1 : uiStatus === 'warning' && seatTier === 'warning' ? 0.4 : validFace ? 0 : 0.25;
  const gazeI =
    lookAwayStrictMs >= LOOK_LONG_MS ? 1 : lookAwayStrictMs >= LOOK_SHORT_MS ? 0.45 : !focused && !noteExempt ? 0.12 : 0;
  const drowsyI =
    earClass === 'micro_sleep_risk' ? 1 : earClass === 'micro_sleep_warning' ? 0.5 : earClass === 'between_blink_and_warning' ? 0.15 : 0;
  pushPartSample(absI, gazeI, drowsyI);

  setStatus(uiStatus);
  drawFaceBox(coords, uiStatus);

  const facePct = lm0 ? Math.round(conf * 100) : 0;
  document.getElementById('face-v').textContent = lm0 ? `${facePct}%` : '없음';
  document.getElementById('face-v').style.color = lm0 ? 'var(--gr)' : 'var(--da)';
  document.getElementById('face-b').style.width = `${facePct}%`;
  document.getElementById('face-b').style.background = facePct >= 70 ? 'var(--gr)' : facePct >= 40 ? 'var(--wa)' : 'var(--da)';

  document.getElementById('mot-v').textContent = `EAR ${avgEar.toFixed(2)}`;
  document.getElementById('mot-v').style.color = avgEar < 0.21 ? 'var(--da)' : 'var(--gr)';
  document.getElementById('mot-b').style.width = `${clampNum(avgEar * 200, 0, 100)}%`;
  document.getElementById('mot-b').style.background = avgEar < 0.21 ? 'var(--da)' : 'var(--gr)';

  document.getElementById('pose-v').textContent = lm0 ? `Y${yawS.toFixed(0)}° P${pitchS.toFixed(0)}°` : '—';
  document.getElementById('pose-v').style.color = focused ? 'var(--gr)' : 'var(--wa)';
  document.getElementById('pose-b').style.width = `${focused ? 85 : 35}%`;
  document.getElementById('pose-b').style.background = focused ? 'var(--gr)' : 'var(--wa)';

  document.getElementById('conf-lbl').textContent = lm0
    ? `시선 Δ${(Math.hypot(gxS, gyS) * 100).toFixed(0)}`
    : '';

  emitStatus(uiStatus, false, coords, {
    yaw: yawS,
    pitch: pitchS,
    ear: avgEar,
    lookMs: lookAwayStrictMs,
  });
}

function updateStats() {
  if (!sessStart) return;
  const now = Date.now();
  const sessMs = now - sessStart;
  const curAbsMs = isAbsent && absStart ? now - absStart : 0;
  const totalAbs = totalAbsMs + curAbsMs;

  lastPartDisplay = rollingParticipation();
  const rate = sessMs > 1000 ? lastPartDisplay : 100;

  document.getElementById('rate-v').textContent = `${Math.round(rate)}%`;
  document.getElementById('rate-v').style.color = rate >= 80 ? 'var(--gr)' : rate >= 60 ? 'var(--wa)' : 'var(--da)';
  document.getElementById('rate-b').style.width = `${rate}%`;
  document.getElementById('rate-b').style.background = rate >= 80 ? 'var(--gr)' : rate >= 60 ? 'var(--wa)' : 'var(--da)';

  document.getElementById('cnt-v').textContent = `${absLogs.length + (isAbsent ? 1 : 0)}회`;
  document.getElementById('tot-abs').textContent = `총 이탈 ${totalAbsMs > 0 ? fms(totalAbsMs) : '--'}`;

  if (isAbsent && absStart) {
    document.getElementById('cur-v').textContent = fms(curAbsMs);
    document.getElementById('cur-v').style.color = 'var(--da)';
  } else {
    document.getElementById('cur-v').textContent = running ? '참여 중' : '대기 중';
    document.getElementById('cur-v').style.color = running ? 'var(--gr)' : 'var(--mu)';
  }

  const m = Math.floor(sessMs / 60000);
  const s = Math.floor((sessMs % 60000) / 1000);
  document.getElementById('sess-t').textContent = `세션: ${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

async function startTracking() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' },
    });
    vid.srcObject = stream;
    await new Promise((r) => {
      vid.onloadedmetadata = r;
    });
    cvs.width = vid.videoWidth || 640;
    cvs.height = vid.videoHeight || 480;
  } catch {
    document.getElementById('load-txt').textContent = '카메라 접근 권한이 필요합니다.';
    document.getElementById('load-ov').style.display = 'flex';
    return;
  }
  running = true;
  consecutiveValid = 0;
  noFaceMs = 0;
  validFaceBuf = [];
  gazeSmoothBuf = [];
  pitchDownMs = 0;
  lookAwayStrictMs = 0;
  earBelowMs = 0;
  prevUiStatus = 'idle';
  statusStart = null;
  partRing = [];
  isAbsent = false;
  absStart = null;
  lastSentStatus = null;
  absLogs = [];
  totalAbsMs = 0;
  document.getElementById('log-body').innerHTML =
    '<div style="padding:12px;font-family:var(--fm);font-size:10px;color:var(--mu);text-align:center" id="log-empty">기록 없음</div>';
  document.getElementById('btn-start').disabled = true;
  document.getElementById('btn-stop').disabled = false;
  setStatus('present');
  detInt = setInterval(detectFrame, SAMPLE_MS);
  tickInt = setInterval(updateStats, 1000);
  tsInt = setInterval(() => {
    const d = new Date();
    document.getElementById('ts-lbl').textContent = [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map((v) => String(v).padStart(2, '0'))
      .join(':');
  }, 500);
}

function stopTracking() {
  running = false;
  emitStatus('idle', true, null, null);
  clearInterval(detInt);
  clearInterval(tickInt);
  clearInterval(tsInt);
  if (vid.srcObject) {
    vid.srcObject.getTracks().forEach((t) => t.stop());
    vid.srcObject = null;
  }
  ctx.clearRect(0, 0, cvs.width, cvs.height);
  setStatus('idle');
  document.getElementById('btn-start').disabled = false;
  document.getElementById('btn-stop').disabled = true;
  document.getElementById('face-v').textContent = '--';
  document.getElementById('mot-v').textContent = '--';
  document.getElementById('pose-v').textContent = '--';
}

document.getElementById('btn-start').addEventListener('click', startTracking);
document.getElementById('btn-stop').addEventListener('click', stopTracking);

document.getElementById('inp-code').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase();
});

function validateServerUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

['inp-name', 'inp-code', 'inp-server'].forEach((id) => {
  document.getElementById(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('btn-join').click();
  });
});

document.getElementById('btn-join').addEventListener('click', () => {
  const name = document.getElementById('inp-name').value.trim();
  const code = document.getElementById('inp-code').value.trim().toUpperCase();
  const serverUrl = document.getElementById('inp-server').value.trim() || 'http://localhost:3000';
  const err = document.getElementById('join-err');
  const btnJoin = document.getElementById('btn-join');
  err.style.display = 'none';
  if (!name) {
    err.textContent = '이름을 입력해주세요.';
    err.style.display = 'block';
    return;
  }
  if (!code || code.length < 4) {
    err.textContent = '세션 코드를 입력해주세요.';
    err.style.display = 'block';
    return;
  }
  if (!validateServerUrl(serverUrl)) {
    err.textContent = '올바른 서버 주소를 입력해주세요. (예: http://localhost:3000)';
    err.style.display = 'block';
    return;
  }

  btnJoin.textContent = '연결 중...';
  btnJoin.disabled = true;

  if (socket) {
    socket.disconnect();
    socket = null;
  }
  socket = io(serverUrl);

  socket.on('connect', () => {
    setConn('ok');
    if (sessStart) {
      socket.emit('join_session', { name, code }, (res) => {
        if (!res.error) {
          thrSec = res.thrSec || thrSec;
          paused = res.paused || false;
          document.getElementById('pause-banner').style.display = paused ? 'block' : 'none';
        }
      });
      return;
    }
    socket.emit('join_session', { name, code }, (res) => {
      if (res.error) {
        err.textContent = res.error;
        err.style.display = 'block';
        btnJoin.textContent = '입장하기';
        btnJoin.disabled = false;
        socket.disconnect();
        socket = null;
        return;
      }
      sessStart = res.sessionStart || Date.now();
      paused = res.paused || false;
      thrSec = res.thrSec || 20;
      document.getElementById('thr-val').textContent = `문서 5s`;
      document.getElementById('join-screen').style.display = 'none';
      document.getElementById('tracker-screen').style.display = 'flex';
      document.getElementById('user-chip').textContent = name;
      if (paused) document.getElementById('pause-banner').style.display = 'block';
    });
  });

  socket.on('connect_error', () => {
    if (sessStart) {
      setConn('err');
      return;
    }
    err.textContent = '서버에 연결할 수 없습니다. 서버 주소를 확인해주세요.';
    err.style.display = 'block';
    btnJoin.textContent = '입장하기';
    btnJoin.disabled = false;
    setConn('err');
    socket.disconnect();
    socket = null;
  });

  socket.on('disconnect', () => setConn('err'));
  socket.on('session_ended', () => {
    stopTracking();
    alert('강사가 세션을 종료했습니다.');
    location.reload();
  });
  socket.on('pause_state', ({ paused: p }) => {
    paused = p;
    document.getElementById('pause-banner').style.display = p ? 'block' : 'none';
  });
  socket.on('threshold_changed', ({ thrSec: t }) => {
    thrSec = t;
    document.getElementById('thr-val').textContent = `문서 5s`;
  });
});

(async () => {
  try {
    document.getElementById('load-txt').textContent = 'MediaPipe Face Landmarker 로딩…';
    faceLandmarker = await createLandmarker();
    document.getElementById('load-ov').style.display = 'none';
    document.getElementById('btn-start').disabled = false;
    setStatus('idle');
  } catch (e) {
    console.error(e);
    document.getElementById('load-txt').textContent = '모델 로딩 실패 — 네트워크·HTTPS를 확인하세요.';
  }
})();
