const MDL = '/weights';
let socket = null;
let running = false;
let sessStart = null;
let absStart = null;
let absLogs = [];
let totalAbsMs = 0;
let noFaceFrames = 0;
let noFaceStart = null;
let isAbsent = false;
let thrSec = 20;
let poseDetector = null;
let detInt = null;
let tickInt = null;
let tsInt = null;
let paused = false;
let lastSentStatus = null;

const vid = document.getElementById('vid');
const cvs = document.getElementById('cvs');
const ctx = cvs.getContext('2d');
const mcvs = document.createElement('canvas');
mcvs.width = 160; mcvs.height = 120;
const mctx = mcvs.getContext('2d');
let prevFrame = null;

function fms(ms) {
  if (!ms || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60);
  return m > 0 ? `${m}분 ${String(s % 60).padStart(2, '0')}초` : `${s}초`;
}
function ft(ts) {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(v => String(v).padStart(2, '0')).join(':');
}

function setStatus(st) {
  const spill = document.getElementById('spill');
  const m = {
    present: ['sp-p', 'PRESENT'],
    warning: ['sp-w', 'WARNING'],
    absent: ['sp-a', 'ABSENT'],
    idle: ['sp-i', 'IDLE'],
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
  const motTag = entry.byMotion ? '<span class="lm">[모션]</span>' : '';
  r.innerHTML = `<span class="lt">${ft(entry.s)} → ${ft(entry.e)}</span>${motTag}<span class="ld">${fms(entry.d)}</span>`;
  document.getElementById('log-body').insertBefore(r, document.getElementById('log-body').firstChild);
}

function emitStatus(status, byMotion, force = false, coords = null) {
  if (!force && lastSentStatus === status) return;
  const payload = { status };
  if (byMotion) payload.byMotion = true;
  if (coords)   payload.coords = coords;
  socket?.emit('status', payload);
  lastSentStatus = status;
}

function extractCoords(det) {
  if (!det) return null;
  const vw = vid.videoWidth  || 640;
  const vh = vid.videoHeight || 480;
  return {
    cx: +((det.box.x + det.box.width  / 2) / vw).toFixed(3),
    cy: +((det.box.y + det.box.height / 2) / vh).toFixed(3),
    w:  +(det.box.width  / vw).toFixed(3),
    h:  +(det.box.height / vh).toFixed(3),
    score: Math.round(det.score * 100),
  };
}

const MOTION = {
  NO_MOTION:      { key: 'NO_MOTION',      label: '없음',      color: 'var(--mu)', bar: 0   },
  LOW_MOTION:     { key: 'LOW_MOTION',     label: '미세',      color: 'var(--mu)', bar: 20  },
  NORMAL_MOTION:  { key: 'NORMAL_MOTION',  label: '정상',      color: 'var(--gr)', bar: 60  },
  HIGH_MOTION:    { key: 'HIGH_MOTION',    label: '큰 움직임', color: 'var(--wa)', bar: 100 },
  SCREEN_BLOCKED: { key: 'SCREEN_BLOCKED', label: '화면 가림', color: 'var(--da)', bar: 30  },
};

function calcMotionLevel() {
  if (!vid.videoWidth) return MOTION.NO_MOTION;
  mctx.drawImage(vid, 0, 0, 160, 120);
  const curr = mctx.getImageData(0, 0, 160, 120);
  const pixelCount = curr.data.length / 4;

  let totalB = 0, minB = 255, maxB = 0;
  for (let i = 0; i < curr.data.length; i += 4) {
    const b = (curr.data[i] + curr.data[i+1] + curr.data[i+2]) / 3;
    totalB += b;
    if (b < minB) minB = b;
    if (b > maxB) maxB = b;
  }
  const avgB = totalB / pixelCount;
  const rangeB = maxB - minB;

  if (avgB < 15 || (rangeB < 25 && avgB < 60)) {
    prevFrame = curr;
    return MOTION.SCREEN_BLOCKED;
  }

  if (!prevFrame) { prevFrame = curr; return MOTION.NO_MOTION; }

  let diff = 0;
  for (let i = 0; i < curr.data.length; i += 4) {
    diff += (Math.abs(curr.data[i]   - prevFrame.data[i])   +
             Math.abs(curr.data[i+1] - prevFrame.data[i+1]) +
             Math.abs(curr.data[i+2] - prevFrame.data[i+2])) / 3;
  }
  prevFrame = curr;

  const val = Math.min(100, (diff / pixelCount) * 3.5);
  if (val < 3)  return MOTION.NO_MOTION;
  if (val < 12) return MOTION.LOW_MOTION;
  if (val < 35) return MOTION.NORMAL_MOTION;
  return MOTION.HIGH_MOTION;
}

async function initPoseDetector() {
  await tf.ready();
  poseDetector = await poseDetection.createDetector(
    poseDetection.SupportedModels.MoveNet,
    { modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING }
  );
}

async function detectPose() {
  if (!poseDetector || !vid.videoWidth) return { detected: false, conf: 0 };
  try {
    const poses = await poseDetector.estimatePoses(vid, { flipHorizontal: true });
    if (!poses.length) return { detected: false, conf: 0 };
    const kps = poses[0].keypoints;
    const valid = kps.filter(kp => kp.score > 0.3);
    const avgConf = Math.round(kps.reduce((s, kp) => s + kp.score, 0) / kps.length * 100);
    return { detected: valid.length >= 4, conf: avgConf };
  } catch {
    return { detected: false, conf: 0 };
  }
}

function drawBox(det) {
  ctx.clearRect(0, 0, cvs.width, cvs.height);
  if (!det) return;
  const b = det.box;
  const sx = cvs.width / (vid.videoWidth || cvs.width);
  const sy = cvs.height / (vid.videoHeight || cvs.height);
  const x = b.x * sx, y = b.y * sy, bw = b.width * sx, bh = b.height * sy;
  const col = isAbsent ? '#ff4d4d' : noFaceFrames > 0 ? '#f5a623' : '#00e5a0';
  ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.strokeRect(x, y, bw, bh);
  const cl = Math.min(bw, bh) * .18; ctx.lineWidth = 2.5;
  [[x,y+cl,x,y,x+cl,y],[x+bw-cl,y,x+bw,y,x+bw,y+cl],
   [x,y+bh-cl,x,y+bh,x+cl,y+bh],[x+bw-cl,y+bh,x+bw,y+bh,x+bw,y+bh-cl]]
    .forEach(([x1,y1,x2,y2,x3,y3]) => { ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.lineTo(x3,y3); ctx.stroke(); });
}

async function detect() {
  if (!running || paused) return;
  const motion = calcMotionLevel();
  const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 });
  const [det, pose] = await Promise.all([
    faceapi.detectSingleFace(vid, opts),
    detectPose(),
  ]);
  const faceConf = det ? Math.round(det.score * 100) : 0;
  const frames = Math.ceil(thrSec * 1000 / 500);
  const coords = extractCoords(det);

  drawBox(det);

  document.getElementById('face-v').textContent = det ? `${faceConf}%` : '없음';
  document.getElementById('face-v').style.color = det ? 'var(--gr)' : 'var(--da)';
  document.getElementById('face-b').style.width = `${faceConf}%`;
  document.getElementById('face-b').style.background = faceConf > 70 ? 'var(--gr)' : faceConf > 40 ? 'var(--wa)' : 'var(--da)';
  document.getElementById('mot-v').textContent = motion.label;
  document.getElementById('mot-v').style.color = motion.color;
  document.getElementById('mot-b').style.width = `${motion.bar}%`;
  document.getElementById('mot-b').style.background = motion.color;
  document.getElementById('conf-lbl').textContent = det ? `${faceConf}%` : '';
  if (!poseDetector) {
    document.getElementById('pose-v').textContent = '비활성';
    document.getElementById('pose-v').style.color = 'var(--mu)';
    document.getElementById('pose-b').style.width = '0%';
  } else {
    document.getElementById('pose-v').textContent = pose.detected ? `${pose.conf}%` : '없음';
    document.getElementById('pose-v').style.color = pose.detected ? 'var(--gr)' : 'var(--mu)';
    document.getElementById('pose-b').style.width = `${pose.conf}%`;
    document.getElementById('pose-b').style.background = pose.detected ? 'var(--gr)' : 'var(--mu)';
  }

  const personPresent = pose.detected
    || motion.key === 'NORMAL_MOTION'
    || motion.key === 'HIGH_MOTION';

  if (det) {
    noFaceFrames = 0;
    noFaceStart = null;
    if (isAbsent) {
      isAbsent = false;
      const dur = Date.now() - absStart;
      const entry = { s: absStart, e: Date.now(), d: dur };
      absLogs.push(entry); totalAbsMs += dur; absStart = null;
      addLog(entry);
      emitStatus('present', false, false, coords);
    } else {
      emitStatus('present', false, false, coords);
    }
    setStatus('present');
  } else if (personPresent) {
    noFaceFrames = Math.max(0, noFaceFrames - 1);
    if (noFaceFrames === 0) noFaceStart = null;
    if (isAbsent) {
      isAbsent = false;
      const dur = Date.now() - absStart;
      const byMotion = !pose.detected;
      const entry = { s: absStart, e: Date.now(), d: dur, byMotion };
      absLogs.push(entry); totalAbsMs += dur; absStart = null;
      addLog(entry);
      emitStatus('present', byMotion, false, null);
      setStatus('present');
    } else {
      emitStatus('warning');
      setStatus('warning');
    }
  } else {
    // NO_MOTION / LOW_MOTION / SCREEN_BLOCKED — 얼굴·자세 모두 없음
    if (noFaceFrames === 0) noFaceStart = Date.now();
    noFaceFrames++;
    if (!isAbsent) {
      if (noFaceFrames >= frames) {
        isAbsent = true;
        absStart = noFaceStart;
        emitStatus('absent', false, false, null);
        setStatus('absent');
      } else {
        emitStatus('warning');
        setStatus('warning');
      }
    }
  }
}

function updateStats() {
  if (!sessStart) return;
  const now = Date.now();
  const sessMs = now - sessStart;
  const curAbsMs = isAbsent && absStart ? now - absStart : 0;
  const totalAbs = totalAbsMs + curAbsMs;
  const rate = sessMs > 1000 ? Math.max(0, Math.min(100, (sessMs - totalAbs) / sessMs * 100)) : 100;

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

  const m = Math.floor(sessMs / 60000), s = Math.floor((sessMs % 60000) / 1000);
  document.getElementById('sess-t').textContent = `세션: ${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

async function startTracking() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' } });
    vid.srcObject = stream;
    await new Promise(r => vid.onloadedmetadata = r);
    cvs.width = vid.videoWidth || 640; cvs.height = vid.videoHeight || 480;
  } catch (e) {
    document.getElementById('load-txt').textContent = '카메라 접근 권한이 필요합니다.';
    document.getElementById('load-ov').style.display = 'flex';
    return;
  }
  running = true; prevFrame = null; noFaceFrames = 0; noFaceStart = null; isAbsent = false; absStart = null;
  lastSentStatus = null;
  absLogs = []; totalAbsMs = 0;
  document.getElementById('log-body').innerHTML = '<div style="padding:12px;font-family:var(--fm);font-size:10px;color:var(--mu);text-align:center" id="log-empty">기록 없음</div>';
  document.getElementById('btn-start').disabled = true;
  document.getElementById('btn-stop').disabled = false;
  setStatus('present');
  detInt = setInterval(detect, 500);
  tickInt = setInterval(updateStats, 1000);
  tsInt = setInterval(() => {
    const d = new Date();
    document.getElementById('ts-lbl').textContent = [d.getHours(),d.getMinutes(),d.getSeconds()].map(v=>String(v).padStart(2,'0')).join(':');
  }, 500);
}

function stopTracking() {
  running = false;
  emitStatus('idle', false, true);
  clearInterval(detInt); clearInterval(tickInt); clearInterval(tsInt);
  if (vid.srcObject) { vid.srcObject.getTracks().forEach(t => t.stop()); vid.srcObject = null; }
  ctx.clearRect(0, 0, cvs.width, cvs.height); prevFrame = null;
  setStatus('idle');
  document.getElementById('btn-start').disabled = false;
  document.getElementById('btn-stop').disabled = true;
  document.getElementById('face-v').textContent = '--';
  document.getElementById('mot-v').textContent = '--';
}

document.getElementById('btn-start').addEventListener('click', startTracking);
document.getElementById('btn-stop').addEventListener('click', stopTracking);

document.getElementById('inp-code').addEventListener('input', e => {
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

// Enter 키로 입장
['inp-name', 'inp-code', 'inp-server'].forEach(id => {
  document.getElementById(id).addEventListener('keydown', e => {
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
  if (!name) { err.textContent = '이름을 입력해주세요.'; err.style.display = 'block'; return; }
  if (!code || code.length < 4) { err.textContent = '세션 코드를 입력해주세요.'; err.style.display = 'block'; return; }
  if (!validateServerUrl(serverUrl)) { err.textContent = '올바른 서버 주소를 입력해주세요. (예: http://localhost:3000)'; err.style.display = 'block'; return; }

  btnJoin.textContent = '연결 중...';
  btnJoin.disabled = true;

  if (socket) { socket.disconnect(); socket = null; }
  socket = io(serverUrl);

  socket.on('connect', () => {
    setConn('ok');
    if (sessStart) {
      // 재연결 — 서버에 재등록하되 로컬 통계는 유지
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
        err.textContent = res.error; err.style.display = 'block';
        btnJoin.textContent = '입장하기';
        btnJoin.disabled = false;
        socket.disconnect(); socket = null;
        return;
      }
      sessStart = res.sessionStart || Date.now();
      paused = res.paused || false;
      thrSec = res.thrSec || 20;
      document.getElementById('thr-val').textContent = `${thrSec}초`;
      document.getElementById('join-screen').style.display = 'none';
      document.getElementById('tracker-screen').style.display = 'flex';
      document.getElementById('user-chip').textContent = name;
      if (paused) document.getElementById('pause-banner').style.display = 'block';
    });
  });

  socket.on('connect_error', () => {
    if (sessStart) { setConn('err'); return; } // 세션 중 재연결 실패 — UI만 업데이트
    err.textContent = '서버에 연결할 수 없습니다. 서버 주소를 확인해주세요.';
    err.style.display = 'block';
    btnJoin.textContent = '입장하기';
    btnJoin.disabled = false;
    setConn('err');
    socket.disconnect(); socket = null;
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
    document.getElementById('thr-val').textContent = `${t}초`;
  });
});

(async () => {
  try {
    document.getElementById('load-txt').textContent = '얼굴 모델 로딩 중...';
    try {
      await faceapi.nets.tinyFaceDetector.loadFromUri('/weights');
    } catch {
      await faceapi.nets.tinyFaceDetector.loadFromUri('https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/weights');
    }
    document.getElementById('load-txt').textContent = '자세 모델 로딩 중...';
    try {
      await initPoseDetector();
    } catch (e) {
      console.warn('자세 모델 로딩 실패, 얼굴 감지만 사용합니다.', e);
      document.getElementById('pose-v').textContent = '비활성';
      document.getElementById('pose-v').style.color = 'var(--da)';
    }
    document.getElementById('load-ov').style.display = 'none';
    document.getElementById('btn-start').disabled = false;
    setStatus('idle');
  } catch (e) {
    document.getElementById('load-txt').textContent = '모델 로딩 실패 — 새로고침 해주세요.';
  }
})();
