// 팀 기능(개인/팀 모드, 로그인)을 쓰려면 Supabase 값을 채우세요.
// 비워 두면 '개인 모드(이 브라우저에만 저장)'로만 동작합니다.
// anon key는 공개되어도 안전하게 설계된 키입니다. 접근은 supabase/schema.sql 의 규칙과 로그인으로 막힙니다.
window.APP_CONFIG = {
  SUPABASE_URL: "https://hvczetwlmfecetwacvit.supabase.co",       // 예: https://abcdxyz.supabase.co
  SUPABASE_ANON_KEY: "sb_publishable_mxwQEC0v2vfIL5dUX-1Lcg_cRtYNOfH"   // Project Settings > API 의 anon public 키
};
