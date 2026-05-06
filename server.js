const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const allowedOrigins = String(process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(v => v.trim())
  .filter(Boolean);

const io = new Server(server, {
  cors: {
    origin: (origin, cb) => {
      if (!origin || !allowedOrigins.length || allowedOrigins.includes(origin)) {
        return cb(null, true);
      }
      return cb(new Error('Not allowed by CORS'));
    },
  },
});

app.use(express.static(path.join(__dirname, 'public')));

const sessions = new Map();
const CODE_RE = /^[A-Z0-9]{5}$/;
const NAME_MAX_LEN = 30;
const VALID_STATUSES = new Set(['absent', 'present', 'warning', 'idle']);

function normalizeName(raw) {
  return String(raw || '').trim().slice(0, NAME_MAX_LEN);
}

function isValidThreshold(value) {
  return Number.isInteger(value) && value >= 5 && value <= 120;
}

function isValidCoords(c) {
  if (!c || typeof c !== 'object') return false;
  return ['cx', 'cy', 'w', 'h'].every(k => typeof c[k] === 'number' && c[k] >= 0 && c[k] <= 1);
}

function csvCell(value) {
  const text = String(value ?? '');
  const formulaSafe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  const escaped = formulaSafe.replace(/"/g, '""');
  return `"${escaped}"`;
}

function findStudentByName(sess, name) {
  for (const st of sess.students.values()) {
    if (st.name === name) return st;
  }
  return null;
}

function genCode() {
  let code;
  do {
    code = Math.random().toString(36).slice(2, 7).toUpperCase();
  } while (sessions.has(code));
  return code;
}

function fmtTime(ts) {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map(v => String(v).padStart(2, '0')).join(':');
}

io.on('connection', (socket) => {

  socket.on('create_session', ({ instructorName }, cb) => {
    const safeName = normalizeName(instructorName);
    if (!safeName) return cb({ error: '강사 이름을 입력해주세요.' });
    const code = genCode();
    sessions.set(code, {
      code,
      instructorName: safeName,
      instructorSocket: socket.id,
      students: new Map(),
      startTime: Date.now(),
      paused: false,
      thrSec: 20,
    });
    socket.join(`s_${code}`);
    socket.data = { code, role: 'instructor' };
    cb({ code });
    console.log(`[세션 생성] ${code} — ${safeName}`);
  });

  socket.on('join_session', ({ name, code }, cb) => {
    const safeName = normalizeName(name);
    const safeCode = String(code || '').trim().toUpperCase();
    if (!safeName) return cb({ error: '이름을 입력해주세요.' });
    if (!CODE_RE.test(safeCode)) return cb({ error: '세션 코드는 5자리 영숫자여야 합니다.' });

    const sess = sessions.get(safeCode);
    if (!sess) return cb({ error: '세션 코드가 올바르지 않습니다.' });

    const prevStudent = findStudentByName(sess, safeName);
    if (prevStudent) {
      sess.students.delete(prevStudent.id);
    }

    const student = prevStudent
      ? {
          ...prevStudent,
          id: socket.id,
          status: 'idle',
          absenceStart: null,
        }
      : {
          id: socket.id,
          name: safeName,
          status: 'idle',
          absenceStart: null,
          logs: [],
          totalAbsMs: 0,
          joinTime: Date.now(),
        };
    sess.students.set(socket.id, student);
    socket.join(`s_${safeCode}`);
    socket.data = { code: safeCode, role: 'student', name: safeName };

    io.to(`s_${safeCode}`).emit('student_joined', { student: sanitize(student) });
    cb({ ok: true, sessionStart: sess.startTime, paused: sess.paused, thrSec: sess.thrSec });
    console.log(`[참여] ${safeName} → 세션 ${safeCode}`);
  });

  socket.on('status', ({ status, byMotion, coords }) => {
    if (!VALID_STATUSES.has(status)) return;
    const { code, role } = socket.data || {};
    if (!code || role !== 'student') return;
    const sess = sessions.get(code);
    if (!sess) return;
    const student = sess.students.get(socket.id);
    if (!student) return;

    const safeCoords = isValidCoords(coords) ? coords : null;
    const prev = student.status;

    if (status === 'absent' && prev !== 'absent') {
      student.status = 'absent';
      student.absenceStart = Date.now();
      student.coords = null;
      io.to(`s_${code}`).emit('student_update', {
        id: socket.id, name: student.name,
        status: 'absent', ts: Date.now(), coords: null,
      });
    } else if (status === 'present' && prev !== 'present') {
      student.coords = safeCoords;
      if (prev === 'absent' && student.absenceStart) {
        const dur = Date.now() - student.absenceStart;
        student.logs.push({ start: student.absenceStart, end: Date.now(), dur });
        student.totalAbsMs += dur;
        student.absenceStart = null;
        io.to(`s_${code}`).emit('student_update', {
          id: socket.id, name: student.name,
          status: 'present', dur, byMotion: !!byMotion, ts: Date.now(), coords: safeCoords,
        });
      } else {
        student.status = 'present';
        io.to(`s_${code}`).emit('student_update', {
          id: socket.id, name: student.name,
          status: 'present', ts: Date.now(), coords: safeCoords,
        });
      }
      student.status = 'present';
    } else if (status === 'warning' && prev !== 'absent' && prev !== 'warning') {
      student.status = 'warning';
      io.to(`s_${code}`).emit('student_update', {
        id: socket.id, name: student.name, status: 'warning', ts: Date.now(), coords: null,
      });
    } else if (status === 'idle' && prev !== 'idle') {
      if (prev === 'absent' && student.absenceStart) {
        const dur = Date.now() - student.absenceStart;
        student.logs.push({ start: student.absenceStart, end: Date.now(), dur });
        student.totalAbsMs += dur;
        student.absenceStart = null;
      }
      student.status = 'idle';
      student.coords = null;
      io.to(`s_${code}`).emit('student_update', {
        id: socket.id, name: student.name, status: 'idle', ts: Date.now(), coords: null,
      });
    }
  });

  socket.on('get_state', ({ code }, cb) => {
    const { code: myCode } = socket.data || {};
    if (!myCode || code !== myCode) return cb({ error: 'unauthorized' });
    const sess = sessions.get(code);
    if (!sess) return cb({ error: 'not found' });
    cb({
      students: Array.from(sess.students.values()).map(sanitize),
      startTime: sess.startTime,
      paused: sess.paused,
    });
  });

  socket.on('set_pause', ({ code, paused }) => {
    const { role, code: myCode } = socket.data || {};
    if (role !== 'instructor' || code !== myCode) return;
    const sess = sessions.get(code);
    if (!sess) return;
    sess.paused = paused;
    io.to(`s_${code}`).emit('pause_state', { paused });
  });

  socket.on('set_threshold', ({ code, thrSec }) => {
    const { role, code: myCode } = socket.data || {};
    if (role !== 'instructor' || code !== myCode) return;
    const sess = sessions.get(code);
    if (!sess) return;
    const nextThr = Number(thrSec);
    if (!isValidThreshold(nextThr)) return;
    sess.thrSec = nextThr;
    io.to(`s_${code}`).emit('threshold_changed', { thrSec: nextThr });
  });

  socket.on('export_csv', ({ code }, cb) => {
    const { role, code: myCode } = socket.data || {};
    if (role !== 'instructor' || code !== myCode) return cb({ csv: '' });
    const sess = sessions.get(code);
    if (!sess) return cb({ csv: '' });
    const now = Date.now();
    const rows = ['학생명,이탈 시작,이탈 종료,이탈(초),참여율(%)'];
    sess.students.forEach(st => {
      const sm = now - st.joinTime;
      const logs = [...st.logs];
      if (st.status === 'absent' && st.absenceStart)
        logs.push({ start: st.absenceStart, end: now, dur: now - st.absenceStart });
      if (!logs.length) { rows.push(`${csvCell(st.name)},,,0,100`); return; }
      logs.forEach(l => {
        const rate = sm > 0 ? Math.round((sm - st.totalAbsMs) / sm * 100) : 100;
        rows.push(`${csvCell(st.name)},${fmtTime(l.start)},${fmtTime(l.end)},${Math.round((l.dur||0)/1000)},${rate}`);
      });
    });
    cb({ csv: rows.join('\n') });
  });

  socket.on('disconnect', () => {
    const { code, role, name } = socket.data || {};
    if (!code) return;
    const sess = sessions.get(code);
    if (!sess) return;
    if (role === 'student') {
      const st = sess.students.get(socket.id);
      if (!st) return;
      if (st.status === 'absent' && st.absenceStart) {
        const dur = Date.now() - st.absenceStart;
        st.logs.push({ start: st.absenceStart, end: Date.now(), dur });
        st.totalAbsMs += dur;
        st.absenceStart = null;
      }
      st.status = 'offline';
      io.to(`s_${code}`).emit('student_update', {
        id: socket.id,
        name,
        status: 'offline',
        ts: Date.now(),
      });
      console.log(`[오프라인] ${name} — 세션 ${code}`);
    } else if (role === 'instructor') {
      io.to(`s_${code}`).emit('session_ended');
      sessions.delete(code);
      console.log(`[세션 종료] ${code} — 강사 연결 끊김`);
    }
  });
});

function sanitize(st) {
  return { id: st.id, name: st.name, status: st.status,
    totalAbsMs: st.totalAbsMs, logs: st.logs.length, joinTime: st.joinTime,
    absenceStart: st.absenceStart, coords: st.coords ?? null };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\nFaceTrack 서버 실행 중 → http://localhost:${PORT}`);
  console.log(`  수강생: http://localhost:${PORT}/student.html`);
  console.log(`  강사:   http://localhost:${PORT}/instructor.html\n`);
  if (allowedOrigins.length) {
    console.log(`  CORS 허용 Origin: ${allowedOrigins.join(', ')}`);
  } else {
    console.log('  CORS 허용 Origin: 전체(개발 모드)');
  }
});
