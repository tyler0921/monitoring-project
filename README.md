# FaceTrack

ZEP 수업 중 수강생 자리이탈 감지 모니터링 웹 서비스

## 사용 방법

### 1. 서버 실행

```bash
npm install
node server.js
```

서버가 실행되면:
- 수강생 페이지: http://localhost:3000/student.html
- 강사 대시보드: http://localhost:3000/instructor.html

### 2. 수업 진행 순서

**강사**
1. `instructor.html` 접속
2. 이름 입력 → 세션 만들기
3. 생성된 **세션 코드**를 수강생에게 공유

**수강생**
1. ZEP 수업 탭 열기
2. `student.html`을 **별도 탭**으로 열기
3. 이름 + 세션 코드 입력 → 입장
4. 카메라 시작 → 감지 시작

### 3. 기능

- 얼굴 감지 + 자세 감지(MoveNet) 복합 판단
- 이탈/복귀 실시간 알림 (강사 대시보드)
- 음성 알림 (이탈: 하강음, 복귀: 상승음)
- 일시정지 기능 (쉬는 시간 제외)
- 세션 종료 후 CSV 내보내기
- 서버 이벤트 로그

### 4. 환경 변수

```bash
PORT=3000  # 기본 포트 (변경 가능)
ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000  # 쉼표 구분 Origin allowlist
```

### 5. 외부 접속 설정

외부 서버에 배포 시 `student.html` 서버 주소를 실제 서버 IP/도메인으로 변경하세요.

예: `http://192.168.1.100:3000` 또는 `https://yourserver.com`

## 파일 구조

```
facetrack/
├── server.js          # Node.js 백엔드
├── package.json
├── README.md
└── public/
    ├── student.html   # 수강생용 (ZEP 옆에 탭으로 열기)
    ├── instructor.html # 강사용 대시보드
    └── weights/       # face-api.js 모델 가중치 (로컬 서빙)
        ├── tiny_face_detector_model-weights_manifest.json
        └── tiny_face_detector_model-shard1
```

## 기술 스택

- Backend: Node.js, Express, Socket.io
- Frontend: face-api.js (얼굴 감지), TensorFlow.js MoveNet (자세 감지)
- 실시간 통신: WebSocket (Socket.io)
