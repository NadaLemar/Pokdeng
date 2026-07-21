# Pokdeng Online — 실시간 멀티플레이어 서버

Node.js + Express + Socket.io 기반의 **공개 테이블(로비) 방식** 실시간 포크덩(Pokdeng) 서버입니다.
룸 코드 없이 목록에서 원하는 테이블을 골라 바로 입장하면, 2명 이상 모였을 때 자동으로 라운드가 시작돼요.
뱅커(딜러)는 매 라운드 다음 사람으로 자동 교체됩니다. 실제 현금 없이 가상 칩(1,000 시작)으로만 진행되는 소셜 게임입니다.

## 폴더 구조

```
pokdeng-mp/
├── shared/
│   └── gameLogic.js      # 서버·클라이언트 공용 룰 (팍/통/리앙/시안 판정)
├── server/
│   ├── server.js         # Socket.io 서버 (룸/베팅/턴/정산)
│   ├── package.json
│   └── public/
│       └── index.html    # 클라이언트 (방 만들기/참가, 실시간 UI)
└── README.md
```

## 로컬에서 실행하기

```bash
cd server
npm install
npm start
```

브라우저에서 `http://localhost:3001` 접속 → 같은 네트워크의 다른 사람도
`http://<내 컴퓨터 IP>:3001` 로 접속하면 함께 플레이할 수 있어요.
(같은 브라우저에서 탭 2개로 테스트도 가능합니다.)

## 온라인으로 배포하기 (실제 서비스처럼 항상 켜두기)

이 서버는 계속 켜져 있어야 하는 프로그램이라, 무료 호스팅 서비스에 올려야
링크 하나로 누구나 접속할 수 있어요. 추천 순서:

1. **Render.com** (무료 티어 있음)
   - GitHub에 이 `pokdeng-mp` 폴더를 올리고
   - Render → New → Web Service → 저장소 연결
   - Root Directory: `server`, Build Command: `npm install`, Start Command: `npm start`
2. **Railway.app** — 위와 거의 동일한 방식, 배포가 조금 더 간단함
3. **Fly.io** — 트래픽이 늘어나면 이쪽이 더 안정적

세 곳 모두 GitHub 저장소만 연결하면 자동 배포되는 방식이라 서버 관리 지식 없이도 가능해요.

## 지금 버전에서 단순화된 부분 (다음 개선 후보)

- 턴 타임아웃(자리 비움 시 자동 스테이 처리) 아직 없음 → 다음 단계에서 추가 예정
- 재접속 시 기존 세션 복구 없음 (새로고침하면 새 플레이어로 인식)
- 테이블은 현재 6개 고정 생성 (필요시 개수/최소 베팅액 조정 가능)
- 뱅커도 사람이 하도록 설계했지만, 봇 뱅커 옵션은 아직 없음
- 채팅/이모지 리액션 없음

## 모바일 앱으로 포팅하기

`shared/gameLogic.js`는 순수 JS라서 React Native(Expo)에서도 그대로 `require`해서 재사용할 수 있어요.
클라이언트 UI만 React Native 컴포넌트로 새로 짜고, 같은 Socket.io 서버에 연결하면 됩니다.
이 부분은 실제 프로젝트 폴더 생성 + Expo 빌드 + 스토어 등록까지 이어지는 별도 작업이라,
Claude Code나 Cowork 환경에서 이어서 진행하는 걸 추천해요.
