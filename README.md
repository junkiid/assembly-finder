# 의원·보좌진 찾기

국회 Open API(국회의원 인적사항)로 의원·보좌진 명단을 매일 오전 9시에 자동 갱신하고, 어제와 달라진 인력 변동을 화면 맨 아래에 보여 주는 팀용 웹사이트입니다. GitHub Pages로 배포하고, 팀 공유는 Supabase를 씁니다.

설정 방법은 [설치안내.md](설치안내.md)를 보세요.

로컬에서 확인하려면 `docs` 폴더에서 `python -m http.server`를 실행하고 `http://localhost:8000`을 엽니다. 변동 비교 로직 테스트는 `python -m unittest scripts/test_update.py`입니다.
