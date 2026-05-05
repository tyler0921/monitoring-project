let socket = null;
let students = new Map();
let sessStart = null;
let sessCode = null;
let paused = false;
let tickInt = null;
let AC = null;

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fms(ms) {
  if (!ms || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60);
  return m > 0 ? `${m}분 ${String(s%60).padStart(2,'0')}초` : `${s}초`;
}
function ft(ts) {
  const d = new Date(ts);
  return [d.getHours(),d.getMinutes(),d.getSeconds()].map(v=>String(v).padStart(2,'0')).join(':');
}

function beep(type) {
  try {
    if (!AC) AC = new (window.AudioContext || /** @type {any} */(window).webkitAudioContext)();
    const o = AC.createOscillator(), g = AC.createGain();
    o.connect(g); g.connect(AC.destination);
    const t = AC.currentTime;
    if (type === 'abs') { o.frequency.setValueAtTime(523,t); o.frequency.setValueAtTime(392,t+.12); g.gain.setValueAtTime(.18,t); g.gain.exponentialRampToValueAtTime(.001,t+.45); }
    else { o.frequency.setValueAtTime(440,t); o.frequency.setValueAtTime(554,t+.1); g.gain.setValueAtTime(.14,t); g.gain.exponentialRampToValueAtTime(.001,t+.3); }
    o.start(t); o.stop(t+.5);
  } catch(e) {}
}

function setConn(st) {
  const dot = document.getElementById('cdot'), lbl = document.getElementById('clbl');
  const m = { ok: ['ok','연결됨'], err: ['err','연결 끊김'], connecting: ['','연결 중'] };
  const [cl, tx] = m[st] || m.connecting;
  dot.className = `cdot ${cl}`; lbl.textContent = tx;
}

function wsLog(dir, evt, data) {
  const l = document.getElementById('ws-log');
  l.querySelector('.empty-msg')?.remove();
  const r = document.createElement('div'); r.className = 'wsrow';
  const col = dir === 'out' ? '#4da6ff' : '#00e5a0';
  const str = esc(typeof data === 'object' ? JSON.stringify(data).slice(0, 40) : String(data));
  r.innerHTML = `<span style="color:${col}">${dir === 'out' ? '↑' : '↓'}</span> <span style="color:var(--tx)">${esc(evt)}</span> <span>${str}</span>`;
  l.insertBefore(r, l.firstChild);
  while (l.children.length > 30) l.removeChild(l.lastChild);
}

function addAlert(name, type, dur, byMotion) {
  const l = document.getElementById('alert-list');
  document.getElementById('alert-empty')?.remove();
  const r = document.createElement('div'); r.className = 'alert-row';
  const col = type === 'abs' ? 'var(--da)' : type === 'join' ? 'var(--in)' : type === 'leave' ? 'var(--mu)' : 'var(--gr)';
  const mot = byMotion ? ' <span style="font-size:9px;color:var(--gr)">[자세]</span>' : '';
  const safeName = esc(name);
  const msg = type === 'abs' ? `${safeName} 이탈` : type === 'join' ? `${safeName} 입장` : type === 'leave' ? `${safeName} 퇴장` : `${safeName} 복귀 (${fms(dur)})${mot}`;
  r.innerHTML = `<span class="adot" style="background:${col}"></span><span style="flex:1">${msg}</span><span class="at2">${ft(Date.now())}</span>`;
  l.insertBefore(r, l.firstChild);
  while (l.children.length > 80) l.removeChild(l.lastChild);
}

function clearAlerts() {
  document.getElementById('alert-list').innerHTML = '<div class="empty-msg" id="alert-empty">알림 없음</div>';
}

function renderCard(st) {
  let card = document.getElementById(`sc-${st.id}`);
  if (!card) {
    document.getElementById('no-students')?.remove();
    card = document.createElement('div');
    card.id = `sc-${st.id}`;
    document.getElementById('sgrid').appendChild(card);
  }
  const statusCls = { present: '', warning: 'warning', absent: 'absent', offline: '', idle: '' };
  const avCls = { present: 'av-p', warning: 'av-w', absent: 'av-a', offline: 'av-o', idle: 'av-o' };
  const badgeCls = { present: 'bp', warning: 'bw', absent: 'ba', offline: 'bo', idle: 'bo' };
  const badgeTx = { present: 'PRESENT', warning: 'WARNING', absent: 'ABSENT', offline: 'OFFLINE', idle: 'IDLE' };
  const ini = esc(st.name.charAt(0));
  const now = Date.now();
  const sessMs = st.joinTime ? now - st.joinTime : 1;
  const curAbsMs = st.status === 'absent' && st.absenceStart ? now - st.absenceStart : 0;
  const totalAbs = (st.totalAbsMs || 0) + curAbsMs;
  const rate = sessMs > 2000 ? Math.max(0, Math.min(100, (sessMs - totalAbs) / sessMs * 100)) : 100;
  const rateColor = rate >= 80 ? 'var(--gr)' : rate >= 60 ? 'var(--wa)' : 'var(--da)';

  card.className = `scard ${statusCls[st.status] || ''}`;
  card.innerHTML = `
    <div class="scard-top">
      <div class="avatar ${avCls[st.status] || 'av-o'}">${ini}</div>
      <div class="scard-name">${esc(st.name)}</div>
      <div class="sbadge ${badgeCls[st.status] || 'bo'}">${badgeTx[st.status] || 'OFFLINE'}</div>
    </div>
    <div class="scard-stats">
      <span>이탈 ${(st.logs || 0) + (st.status === 'absent' ? 1 : 0)}회</span>
      ${totalAbs > 1000 ? `<span class="at">${fms(totalAbs)}</span>` : ''}
    </div>
    <div class="pbar"><div class="pbar-fill" style="width:${rate}%;background:${rateColor}"></div></div>`;
}

function removeCard(id) {
  document.getElementById(`sc-${id}`)?.remove();
  if (!document.getElementById('sgrid').children.length) {
    const d = document.createElement('div');
    d.className = 'no-students'; d.id = 'no-students';
    d.innerHTML = '학생 입장을 기다리는 중...<br><br><span style="font-size:10px;opacity:.6">세션 코드를 학생들에게 공유하세요</span>';
    document.getElementById('sgrid').appendChild(d);
  }
}

function updateGlobal() {
  const all = Array.from(students.values());
  const absent = all.filter(s => s.status === 'absent');
  document.getElementById('st-tot').textContent = all.length;
  const ae = document.getElementById('st-abs');
  ae.textContent = absent.length;
  ae.style.color = absent.length > 0 ? 'var(--da)' : 'var(--tx)';
  const re = document.getElementById('st-rate');
  if (all.length > 0) {
    const now = Date.now();
    let sum = 0;
    all.forEach(s => {
      const sm = s.joinTime ? now - s.joinTime : 1;
      const ca = s.status === 'absent' && s.absenceStart ? now - s.absenceStart : 0;
      sum += Math.max(0, Math.min(100, (sm - (s.totalAbsMs||0) - ca) / sm * 100));
    });
    const avg = Math.round(sum / all.length);
    re.textContent = `${avg}%`;
    re.style.color = avg >= 80 ? 'var(--gr)' : avg >= 60 ? 'var(--wa)' : 'var(--da)';
  } else {
    re.textContent = '--%';
    re.style.color = 'var(--gr)';
  }
  all.forEach(s => renderCard(s));
}

function copyCode() {
  if (!sessCode) return;
  navigator.clipboard.writeText(sessCode).then(() => {
    const b = document.getElementById('code-badge');
    b.textContent = '복사됨!';
    setTimeout(() => b.textContent = sessCode, 1500);
  });
}

function togglePause() {
  paused = !paused;
  socket?.emit('set_pause', { code: sessCode, paused });
  const btn = document.getElementById('btn-pause');
  btn.textContent = paused ? '감지 재개' : '일시정지';
  btn.className = paused ? 'btn btn-warn' : 'btn';
}

function exportCSV() {
  socket?.emit('export_csv', { code: sessCode }, ({ csv }) => {
    if (!csv) return;
    // UTF-8 BOM(﻿) 추가로 Excel 한글 깨짐 방지
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `facetrack_${new Date().toISOString().slice(0,10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
  });
}

function endSession() {
  if (!confirm('세션을 종료하시겠습니까?')) return;
  socket?.disconnect();
  location.reload();
}

function validateServerUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// 정적 버튼 이벤트 — 인라인 onclick 대신 addEventListener 사용
document.getElementById('code-badge').addEventListener('click', copyCode);
document.getElementById('btn-clear-alerts').addEventListener('click', clearAlerts);
document.getElementById('btn-pause').addEventListener('click', togglePause);
document.getElementById('btn-csv').addEventListener('click', exportCSV);
document.getElementById('btn-end').addEventListener('click', endSession);

// 임계값 변경 리스너는 클릭 핸들러 바깥에서 한 번만 등록
document.getElementById('thr-disp').addEventListener('change', () => {
  const thrSec = parseInt(document.getElementById('thr-disp').value);
  socket?.emit('set_threshold', { code: sessCode, thrSec });
});

// Enter 키로 세션 생성
['inp-name', 'inp-server'].forEach(id => {
  document.getElementById(id).addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-create').click();
  });
});

function startSession(name, serverUrl) {
  const err = document.getElementById('create-err');
  const btnCreate = document.getElementById('btn-create');

  if (socket) { socket.disconnect(); socket = null; }

  socket = io(serverUrl);

  socket.on('connect', () => {
    setConn('ok');
    if (sessCode) return; // 재연결 시 세션 중복 생성 방지
    socket.emit('create_session', { instructorName: name }, ({ code, error }) => {
      if (error || !code) {
        err.textContent = error || '세션 생성에 실패했습니다.';
        err.style.display = 'block';
        btnCreate.textContent = '세션 만들기';
        btnCreate.disabled = false;
        socket.disconnect(); socket = null;
        return;
      }
      sessCode = code; sessStart = Date.now();
      document.getElementById('create-screen').style.display = 'none';
      document.getElementById('dashboard').style.display = 'flex';
      document.getElementById('code-badge').textContent = code;
      document.getElementById('btn-csv').disabled = false;
      wsLog('in', 'session_created', { code });
      tickInt = setInterval(() => {
        if (!sessStart) return;
        const ms = Date.now() - sessStart;
        const m = Math.floor(ms/60000), s = Math.floor((ms%60000)/1000);
        document.getElementById('st-time').textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
        updateGlobal();
      }, 1000);
    });
  });

  socket.on('connect_error', () => {
    if (sessCode) { setConn('err'); return; } // 세션 진행 중 재연결 실패는 UI만 업데이트
    err.textContent = '서버에 연결할 수 없습니다.';
    err.style.display = 'block';
    btnCreate.textContent = '세션 만들기';
    btnCreate.disabled = false;
    setConn('err');
    socket.disconnect(); socket = null;
  });

  socket.on('disconnect', () => setConn('err'));

  socket.on('student_joined', ({ student }) => {
    student.absenceStart = null;
    student.totalAbsMs = student.totalAbsMs || 0;
    student.logs = student.logs || 0;
    students.set(student.id, student);
    renderCard(student);
    updateGlobal();
    addAlert(student.name, 'join', 0);
    wsLog('in', 'student_joined', { name: student.name });
  });

  socket.on('student_update', ({ id, name, status, dur, byMotion }) => {
    const st = students.get(id);
    if (!st) return;
    const prev = st.status;
    st.status = status;
    if (status === 'absent') {
      st.absenceStart = Date.now();
      addAlert(name, 'abs', 0);
      beep('abs');
    } else if (status === 'present' && prev === 'absent') {
      st.totalAbsMs = (st.totalAbsMs || 0) + (dur || 0);
      st.logs = (st.logs || 0) + 1;
      st.absenceStart = null;
      addAlert(name, 'ret', dur, byMotion);
      beep('ret');
    } else if (status === 'present' || status === 'warning') {
      st.absenceStart = null;
    } else if (status === 'offline') {
      st.absenceStart = null;
      if (prev !== 'offline') addAlert(name, 'leave', 0);
    }
    renderCard(st);
    updateGlobal();
    wsLog('in', `status:${status}`, { name });
  });

  socket.on('student_left', ({ id, name }) => {
    students.delete(id);
    removeCard(id);
    addAlert(name, 'leave', 0);
    updateGlobal();
    wsLog('in', 'student_left', { name });
  });
}

document.getElementById('btn-create').addEventListener('click', () => {
  const name = document.getElementById('inp-name').value.trim();
  const serverUrl = document.getElementById('inp-server').value.trim() || 'http://localhost:3000';
  const err = document.getElementById('create-err');
  const btnCreate = document.getElementById('btn-create');
  err.style.display = 'none';
  if (!name) { err.textContent = '이름을 입력해주세요.'; err.style.display = 'block'; return; }
  if (!validateServerUrl(serverUrl)) { err.textContent = '올바른 서버 주소를 입력해주세요. (예: http://localhost:3000)'; err.style.display = 'block'; return; }
  btnCreate.textContent = '연결 중...';
  btnCreate.disabled = true;
  startSession(name, serverUrl);
});
