/* 의원·보좌진 찾기
 * 데이터: data/members.json, data/changes.json, data/meta.json (매일 자동 갱신)
 * 개인 모드: 내가 표시한 '아는 사람'과 내 메모
 * 팀 모드  : 팀원들이 표시한 '아는 사람'을 합쳐서 보여줌 (메모는 본인만 보임)
 */
(function () {
'use strict';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CFG = window.APP_CONFIG || {};
const ROLES = ['보좌관', '비서관', '비서'];
const PARTY_CLS = { '더불어민주당': 'pty-dp', '국민의힘': 'pty-ppp', '조국혁신당': 'pty-rk', '개혁신당': 'pty-rf' };
const pty = (p) => (p ? '<span class="pty ' + (PARTY_CLS[p] || '') + '">' + esc(p) + '</span>' : '');
const idOf = (code) => String(code || '').replace(/[^A-Za-z0-9]/g, '');
const LS_MODE = 'af-mode', LS_SEEN = 'af-seen-date';
const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* 저장 불가 환경 */ } };

/* ---------- 상태 ---------- */
let members = [], staffIdx = [], memberById = {}, validKeys = {}, meta = {}, changes = [];
let mode = lsGet(LS_MODE) === 'team' ? 'team' : 'personal';
let query = '', party = '', lastQuery = '', chgOnly = false;
let sb = null, me = null, authOpen = false, authMsg = '', inited = false;
let myMarks = new Set(), myMemos = {}, othersMarks = [], profiles = {}, kmap = {};
let pending = 0, queue = Promise.resolve();
const memoTimers = {};

/* ---------- 표시 저장 (이 브라우저 / 로그인 시 서버) ---------- */
const cacheKey = () => 'af-marks-v2-' + (me ? me.uid : 'local');
function cacheRead(which) {
  try {
    const o = JSON.parse(lsGet('af-marks-v2-' + which) || '{}');
    return { marks: Array.isArray(o.marks) ? o.marks : [], memos: o.memos && typeof o.memos === 'object' ? o.memos : {} };
  } catch (e) { return { marks: [], memos: {} }; }
}
function cacheWrite() { lsSet(cacheKey(), JSON.stringify({ marks: [...myMarks], memos: myMemos })); }
function useLocalCache() { const c = cacheRead('local'); myMarks = new Set(c.marks); myMemos = c.memos; }

function rebuildKmap() {
  kmap = {};
  myMarks.forEach((k) => { (kmap[k] = kmap[k] || []).push('me'); });
  othersMarks.forEach((r) => { (kmap[r.key] = kmap[r.key] || []).push(r.user_id); });
}
const isKnown = (key) => (mode === 'team' ? !!(kmap[key] && kmap[key].length) : myMarks.has(key));
function knowerNames(key) {
  return (kmap[key] || []).slice().sort((a, b) => (a === 'me' ? -1 : b === 'me' ? 1 : 0))
    .map((id) => (id === 'me' ? '나' : profiles[id] || '팀원'));
}

function remote(fn) {
  if (!sb || !me) return;
  pending++;
  queue = queue.then(fn)
    .catch((e) => setStatus('서버에 저장하지 못했습니다. 잠시 후 다시 시도하세요. (' + ((e && e.message) || e) + ')', true))
    .then(() => { pending--; });
}
function toggleMine(key) {
  if (myMarks.has(key)) {
    myMarks.delete(key);
    const hadMemo = key in myMemos; delete myMemos[key];
    remote(async () => {
      let r = await sb.from('marks').delete().eq('user_id', me.uid).eq('key', key); if (r.error) throw r.error;
      if (hadMemo) { r = await sb.from('memos').delete().eq('user_id', me.uid).eq('key', key); if (r.error) throw r.error; }
    });
  } else {
    myMarks.add(key);
    remote(async () => { const r = await sb.from('marks').insert({ user_id: me.uid, key }); if (r.error && r.error.code !== '23505') throw r.error; });
  }
  rebuildKmap(); cacheWrite(); updateMeta();
}
function setMemo(key, v) {
  if (!myMarks.has(key)) return;
  myMemos[key] = v; cacheWrite();
  clearTimeout(memoTimers[key]);
  memoTimers[key] = setTimeout(() => remote(async () => {
    if (!myMarks.has(key)) return;
    const r = v
      ? await sb.from('memos').upsert({ user_id: me.uid, key, memo: v, updated_at: new Date().toISOString() })
      : await sb.from('memos').delete().eq('user_id', me.uid).eq('key', key);
    if (r.error) throw r.error;
  }), 600);
}
const sig = () => JSON.stringify([[...myMarks].sort(), othersMarks.map((r) => r.user_id + '|' + r.key).sort(), profiles]);

async function loadRemote() {
  const [pr, mk, mm] = await Promise.all([
    sb.from('profiles').select('user_id,name'),
    sb.from('marks').select('user_id,key'),
    sb.from('memos').select('key,memo').eq('user_id', me.uid),
  ]);
  const err = pr.error || mk.error || mm.error;
  if (err) { setStatus('팀 데이터를 불러오지 못했습니다: ' + err.message, true); return false; }
  profiles = {}; pr.data.forEach((p) => { profiles[p.user_id] = p.name; });
  const mine = new Set(); const others = [];
  mk.data.forEach((r) => { if (r.user_id === me.uid) mine.add(r.key); else others.push(r); });
  const memos = {}; mm.data.forEach((r) => { memos[r.key] = r.memo; });

  // 처음 로그인할 때 한 번만, 이 브라우저에 있던 표시를 내 계정으로 옮긴다
  const flag = 'af-migrated-' + me.uid;
  if (!lsGet(flag)) {
    const anon = cacheRead('local');
    let allOk = true;
    const addKeys = anon.marks.filter((k) => !mine.has(k));
    if (addKeys.length) {
      const r = await sb.from('marks').insert(addKeys.map((k) => ({ user_id: me.uid, key: k })));
      if (r.error) allOk = false; else addKeys.forEach((k) => mine.add(k));
    }
    const memoKeys = Object.keys(anon.memos).filter((k) => anon.memos[k] && !(k in memos) && mine.has(k));
    if (memoKeys.length) {
      const r = await sb.from('memos').upsert(memoKeys.map((k) => ({ user_id: me.uid, key: k, memo: anon.memos[k] })));
      if (r.error) allOk = false; else memoKeys.forEach((k) => { memos[k] = anon.memos[k]; });
    }
    if (allOk) {
      lsSet(flag, '1');
      // 옮겨 간 임시 표시는 지운다. 같은 브라우저로 다른 팀원이 로그인해도 이어받지 않도록.
      lsSet('af-marks-v2-local', JSON.stringify({ marks: [], memos: {} }));
    }
  }
  myMarks = mine; myMemos = memos; othersMarks = others;
  rebuildKmap(); cacheWrite();
  return true;
}
async function pollTeam() {
  if (!sb || !me || pending > 0 || document.visibilityState !== 'visible') return;
  const before = sig();
  if (!(await loadRemote())) return;
  if (sig() !== before) {
    const a = document.activeElement;
    if (!(a && a.classList && a.classList.contains('memo'))) render(true);
    updateMeta();
  }
}

/* ---------- 로그인 ---------- */
async function initAuth() {
  const { data } = await sb.auth.getSession();
  await onSession(data && data.session);
  sb.auth.onAuthStateChange((_ev, session) => { setTimeout(() => onSession(session), 0); });
}
async function onSession(session) {
  const uid = session && session.user ? session.user.id : null;
  if (inited && uid === (me ? me.uid : null)) return;
  inited = true;
  if (!uid) {
    const wasIn = !!me;
    me = null; othersMarks = []; profiles = {};
    if (wasIn) useLocalCache();
    rebuildKmap();
    if (mode === 'team') mode = 'personal';
  } else {
    me = { uid, email: (session.user && session.user.email) || '' };
    await loadRemote();
    if (!profiles[uid]) { authOpen = true; authMsg = '팀원에게 보일 이름을 정해 주세요.'; }
    else if (authOpen && authMsg.indexOf('로그인') >= 0) { authOpen = false; authMsg = ''; }
  }
  applyModeUi(); renderAuth(); updateMeta(); render(true);
}
function renderAuth() {
  const btn = $('#authBtn'), panel = $('#authpanel');
  if (!sb) { btn.hidden = true; panel.hidden = true; $('#mTeam').title = '팀 기능이 아직 설정되지 않았습니다 (docs/config.js)'; return; }
  btn.hidden = false;
  btn.textContent = me ? ((profiles[me.uid] || me.email || '내 계정') + ' ▾') : '로그인';
  panel.hidden = !authOpen;
  if (!authOpen) return;
  const msg = authMsg ? '<p class="authmsg" id="authmsg">' + esc(authMsg) + '</p>' : '';
  if (!me) {
    panel.innerHTML = '<form id="loginForm"><label for="email">팀 이메일로 로그인</label>'
      + '<input id="email" type="email" required placeholder="이메일 주소" autocomplete="email">'
      + '<button class="btn primary" type="submit">로그인 링크 받기</button></form>'
      + '<p class="hint" style="margin:0">메일로 온 링크를 누르면 로그인됩니다. 팀 관리자가 등록한 이메일만 사용할 수 있습니다.</p>' + msg;
  } else {
    panel.innerHTML = '<form id="nameForm"><label for="nameIn">팀원에게 보일 이름</label>'
      + '<input id="nameIn" type="text" maxlength="20" required value="' + esc(profiles[me.uid] || '') + '" placeholder="예: 홍길동">'
      + '<button class="btn primary" type="submit">저장</button>'
      + '<button class="btn" type="button" id="logout">로그아웃</button></form>' + msg;
  }
}
async function signIn(email) {
  authMsg = '링크를 보내는 중입니다…'; renderAuth();
  const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: location.origin + location.pathname } });
  const net = error && (error.name === 'AuthRetryableFetchError' || /fetch|network|load failed/i.test(error.message || ''));
  const notReg = error && /signups? not allowed|user not found/i.test(error.message || '');
  authMsg = net ? 'Supabase에 연결하지 못했습니다. 이메일 문제가 아니라 접속 문제입니다. docs/config.js의 SUPABASE_URL이 https://프로젝트이름.supabase.co 형태인지, Supabase 프로젝트가 일시 중지되지 않았는지 확인하세요. (' + error.message + ')'
    : notReg ? '로그인 링크를 보내지 못했습니다. 등록되지 않은 이메일입니다. 팀 관리자에게 Supabase의 Users에 추가해 달라고 요청하세요.'
    : error ? '로그인 링크를 보내지 못했습니다. (' + error.message + ')'
    : '메일을 보냈습니다. 메일의 링크를 누르면 이 화면으로 돌아와 로그인됩니다. (로그인 후 이 메시지는 사라집니다)';
  renderAuth();
}
async function saveName(name) {
  const r = await sb.from('profiles').upsert({ user_id: me.uid, name, updated_at: new Date().toISOString() });
  if (r.error) { authMsg = '이름을 저장하지 못했습니다: ' + r.error.message; renderAuth(); return; }
  profiles[me.uid] = name; authOpen = false; authMsg = '';
  renderAuth(); render(true);
}

/* ---------- 모드 ---------- */
function applyModeUi() {
  $('#mPersonal').setAttribute('aria-pressed', mode === 'personal' ? 'true' : 'false');
  $('#mTeam').setAttribute('aria-pressed', mode === 'team' ? 'true' : 'false');
  $('#onlyKnownLbl').textContent = mode === 'team' ? '팀이 아는 사람만' : '내가 아는 사람만';
  $('#netnote').textContent = !sb ? '아는 사람 표시와 메모는 이 브라우저에만 저장됩니다.'
    : me ? '표시는 팀원에게 보이고, 메모는 나에게만 보입니다.'
    : '로그인하면 팀원과 표시를 합쳐 볼 수 있습니다. 지금은 이 브라우저에만 저장됩니다.';
}
function setMode(m) {
  if (m === 'team' && !me) {
    authOpen = true; authMsg = sb ? '팀 모드는 로그인이 필요합니다.' : ''; renderAuth();
    if (!sb) setStatus('팀 기능이 아직 설정되지 않았습니다. 설치 안내의 Supabase 설정을 먼저 해 주세요.', true);
    return;
  }
  mode = m; lsSet(LS_MODE, m); applyModeUi(); updateMeta(); render(true);
}

/* ---------- 데이터 ---------- */
function setMembers(list) {
  members = list.map((m, i) => {
    m.staff = m.staff || {}; ROLES.forEach((r) => { m.staff[r] = m.staff[r] || []; });
    m.committees = m.committees || [];
    m.id = idOf(m.code) || ('x' + i);
    return m;
  });
  memberById = {}; members.forEach((m) => { memberById[m.id] = m; });
  staffIdx = [];
  members.forEach((m) => ROLES.forEach((r) => m.staff[r].forEach((n) => staffIdx.push({ name: n, role: r, m, key: 's:' + m.id + ':' + n }))));
  const parties = {}; members.forEach((m) => { if (m.party) parties[m.party] = 1; });
  const sel = $('#party'), cur = party;
  sel.innerHTML = '<option value="">전체 정당</option>' + Object.keys(parties).sort((a, b) => a.localeCompare(b, 'ko')).map((p) => '<option>' + esc(p) + '</option>').join('');
  sel.value = parties[cur] ? cur : ''; party = sel.value;
  validKeys = {}; members.forEach((m) => { validKeys['m:' + m.id] = 1; }); staffIdx.forEach((e) => { validKeys[e.key] = 1; });
  updateMeta();
}
async function loadData() {
  try {
    const bust = '?v=' + Date.now();
    const get = (u) => fetch(u + bust, { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error(u + ' (' + r.status + ')'); return r.json(); });
    const [m, c, t] = await Promise.all([get('data/members.json'), get('data/changes.json'), get('data/meta.json')]);
    meta = t || {}; changes = (c && c.entries) || [];
    setMembers(Array.isArray(m) ? m : []);
  } catch (e) {
    setStatus('데이터를 불러오지 못했습니다: ' + e.message, true);
    setMembers([]);
  }
}
const fmtTime = (iso) => (iso ? String(iso).replace('T', ' ').slice(0, 16) : '');
function unseenCount() {
  const seen = lsGet(LS_SEEN) || '';
  return changes.filter((e) => e.date > seen).reduce((n, e) => n + e.events.length, 0);
}
function updateMeta() {
  let base;
  if (!members.length) base = '명단 데이터가 아직 없습니다';
  else {
    const uniq = {}; staffIdx.forEach((e) => { uniq[e.name] = 1; });
    base = '의원 ' + members.length + '명 · 보좌진 ' + staffIdx.length + '건 (이름 기준 ' + Object.keys(uniq).length + '명)';
  }
  let n = 0;
  if (mode === 'team') Object.keys(kmap).forEach((k) => { if (validKeys[k] && kmap[k].length) n++; });
  else myMarks.forEach((k) => { if (validKeys[k]) n++; });
  $('#meta').textContent = base + (n ? ' · ' + (mode === 'team' ? '팀이' : '내가') + ' 아는 사람 ' + n + '명' : '');
  $('#updated').textContent = meta.updatedAt ? '마지막 갱신 ' + fmtTime(meta.updatedAt) + ' (매일 오전 9시 자동 갱신)' : '';
  const u = unseenCount(), b = $('#chgBadge');
  b.hidden = !u; b.textContent = u;
}
function setStatus(t, err) { const s = $('#status'); s.textContent = t || ''; s.className = 'status' + (err ? ' err' : ''); }

/* ---------- 화면 ---------- */
function hl(text, q) {
  const t = String(text), s = (q || '').trim(); if (!s) return esc(t);
  const i = t.toLowerCase().indexOf(s.toLowerCase()); if (i < 0) return esc(t);
  return esc(t.slice(0, i)) + '<mark>' + esc(t.slice(i, i + s.length)) + '</mark>' + esc(t.slice(i + s.length));
}
const knownBadge = (key) => (!isKnown(key) ? '' : mode === 'team'
  ? '<span class="chip known">★ 팀 ' + (kmap[key] || []).length + '명</span>'
  : '<span class="chip known">★ 아는 사람</span>');
const knownStaffCount = (m) => { let n = 0; ROLES.forEach((r) => m.staff[r].forEach((nm) => { if (isKnown('s:' + m.id + ':' + nm)) n++; })); return n; };
const knowersLine = (key) => (mode === 'team' && isKnown(key) ? '<div class="sub">아는 사람: ' + esc(knowerNames(key).join(', ')) + '</div>' : '');
const memoLine = (key) => (myMarks.has(key) && myMemos[key] ? '<div class="sub memo-line">' + esc(myMemos[key]) + '</div>' : '');

function memberRow(m, q) {
  const key = 'm:' + m.id, ks = knownStaffCount(m);
  const badges = knownBadge(key) + (ks ? '<span class="chip known">아는 보좌진 ' + ks + '명</span>' : '');
  return '<a class="row" href="#m-' + esc(m.id) + '"><div class="nm">' + hl(m.name, q) + '</div><div class="sub">'
    + pty(m.party) + (m.district ? ' ' + hl(m.district, q) : '') + (roomOf(m.office) ? (m.district ? ' · ' : ' ') + esc(roomOf(m.office)) : '') + '</div>'
    + (badges ? '<div class="badges">' + badges + '</div>' : '') + knowersLine(key) + memoLine(key) + '</a>';
}
function staffRow(e, q) {
  return '<a class="row" href="#m-' + esc(e.m.id) + '"><div class="staffrow"><span class="nm">' + hl(e.name, q) + '</span><span class="chip role">' + esc(e.role) + '</span>'
    + knownBadge(e.key) + '</div><div class="sub">' + esc(e.m.name) + ' 의원실' + (e.m.party ? ' · ' + pty(e.m.party) : '') + '</div>'
    + knowersLine(e.key) + memoLine(e.key) + '</a>';
}
const byParty = (m) => !party || m.party === party;
// '의원회관 341호' → '341호' (호수를 못 찾으면 사무실 정보를 그대로)
const roomOf = (office) => { const m = String(office || '').match(/\d+\s*호/); return m ? m[0].replace(/\s+/g, '') : String(office || '').trim(); };
const squash = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
// 의원 이름 또는 선거구에 검색어가 들어 있으면 일치 (선거구는 띄어쓰기 무시: '강남갑'으로도 '서울 강남구갑'을 찾음)
const matchMember = (m, q) => m.name.toLowerCase().indexOf(q.toLowerCase()) >= 0 || squash(m.district).indexOf(squash(q)) >= 0;

function renderHome() {
  const q = query.trim(), only = $('#onlyKnown').checked, low = q.toLowerCase();
  let html = '';
  if (!members.length) {
    html = '<div class="empty-state">아직 명단 데이터가 없습니다. 저장소의 <b>Actions</b> 탭에서 "명단 갱신 및 배포"를 한 번 실행하면 채워집니다.</div>';
  } else {
    const ms = members.filter((m) => byParty(m) && (!only || isKnown('m:' + m.id) || knownStaffCount(m) > 0) && (!q || matchMember(m, q)))
      .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    const st = (q || only) ? staffIdx.filter((e) => byParty(e.m) && (!only || isKnown(e.key)) && (!q || e.name.toLowerCase().indexOf(low) >= 0)) : [];
    const cap = 100, shown = st.slice(0, cap);
    if (!ms.length && !st.length) {
      html = '<p class="empty">' + (q ? '"' + esc(q) + '"와 일치하는 ' : '') + (only ? '아는 ' : '') + '의원이나 보좌진이 없습니다.'
        + (only && !q ? ' 의원 상세 페이지에서 ☆를 눌러 표시하세요.' : '') + '</p>';
    } else {
      if (ms.length) html += '<h2>의원 <span class="count">' + ms.length + '</span>명</h2><div class="grid">' + ms.map((m) => memberRow(m, q)).join('') + '</div>';
      if (st.length) {
        html += '<h2 style="margin-top:20px">보좌진 <span class="count">' + st.length + '</span>건</h2><div class="grid">' + shown.map((e) => staffRow(e, q)).join('') + '</div>';
        if (st.length > cap) html += '<p class="hint">상위 ' + cap + '건만 표시했습니다. 이름을 더 길게 입력해 좁혀 보세요.</p>';
      }
    }
  }
  $('#view').innerHTML = html + changesHtml();
  watchChanges();
}

function renderMember(m, keep) {
  const q = lastQuery, mk = 'm:' + m.id, mine = myMarks.has(mk);
  const sections = ROLES.map((r) => {
    const list = m.staff[r];
    const body = list.length ? '<div class="people">' + list.map((n) => {
      const key = 's:' + m.id + ':' + n, kn = isKnown(key), my = myMarks.has(key);
      const others = staffIdx.filter((e) => e.name === n && e.m !== m).length;
      const on = q && q.trim() && n.toLowerCase().indexOf(q.trim().toLowerCase()) >= 0;
      const teamTxt = mode === 'team' && kn ? '<small>아는 사람: ' + esc(knowerNames(key).join(', ')) + '</small>' : '';
      return '<div class="person' + (kn ? ' is-known' : '') + '"><div class="pline">'
        + '<button type="button" class="pname" data-search="' + esc(n) + '" title="이 이름으로 전체 의원실 검색">' + (on ? '<mark>' + esc(n) + '</mark>' : esc(n)) + '</button>'
        + '<button type="button" class="star" data-known="' + esc(key) + '" aria-pressed="' + (my ? 'true' : 'false') + '" aria-label="' + esc(n) + ' 내가 아는 사람 표시" title="내가 아는 사람 표시">' + (my ? '★' : '☆') + '</button></div>'
        + teamTxt + (others ? '<small>다른 의원실 ' + others + '곳에 같은 이름</small>' : '')
        + (my ? '<input class="memo" data-memo="' + esc(key) + '" maxlength="200" placeholder="내 메모 (나에게만 보임)" value="' + esc(myMemos[key] || '') + '" aria-label="' + esc(n) + ' 메모">' : '')
        + '</div>';
    }).join('') + '</div>' : '<p class="empty">등록된 인원이 없습니다.</p>';
    return '<section class="sec"><h4>' + r + ' <span class="count">' + list.length + '명</span></h4>' + body + '</section>';
  }).join('');
  const cm = m.committees.length ? '<div class="chips">' + m.committees.map((c) => '<span class="chip">' + esc(c) + '</span>').join('') + '</div>' : '<p class="empty">등록된 위원회가 없습니다.</p>';
  const teamKnow = mode === 'team' && isKnown(mk) ? '<p class="hint" style="margin:6px 0 0">이 의원을 아는 팀원: ' + esc(knowerNames(mk).join(', ')) + '</p>' : '';
  $('#view').innerHTML = '<a class="back" href="#">← 목록으로</a><article class="card"><h3>' + esc(m.name) + pty(m.party) + '</h3>'
    + '<div class="kbar"><button type="button" class="kbtn" data-known="' + esc(mk) + '" aria-pressed="' + (mine ? 'true' : 'false') + '">' + (mine ? '★ 내가 아는 사람' : '☆ 아는 사람으로 표시') + '</button>'
    + (mine ? '<input class="memo" data-memo="' + esc(mk) + '" maxlength="200" placeholder="내 메모 (어디서 알게 됐는지, 연락 이력 등 · 나에게만 보임)" value="' + esc(myMemos[mk] || '') + '" aria-label="의원 메모">' : '') + '</div>'
    + teamKnow
    + '<dl class="facts"><div><dt>정당</dt><dd>' + (m.party ? pty(m.party) : '-') + '</dd></div>'
    + fact('선거구', m.district) + fact('사무실', m.office) + fact('직책', m.role) + '</dl>'
    + '<section class="sec"><h4>소속 위원회 <span class="count">' + m.committees.length + '곳</span></h4>' + cm + '</section>'
    + sections
    + '<p class="hint">☆는 내가 아는 사람 표시입니다. 이름을 누르면 그 이름으로 전체 의원실을 검색합니다. 이름만으로는 같은 사람인지 구분할 수 없습니다.</p></article>';
  if (!keep) window.scrollTo(0, 0);
}
const fact = (k, v) => '<div><dt>' + k + '</dt><dd>' + (v ? esc(v) : '-') + '</dd></div>';

/* ---------- 변동 안내 (메인 페이지 맨 아래) ---------- */
const memberLink = (code, name) => {
  const m = memberById[idOf(code)], t = esc(name);
  return m ? '<a href="#m-' + esc(m.id) + '">' + t + '</a>' : t;
};
function evKeys(e) {
  switch (e.type) {
    case 'staff_added': case 'staff_removed': case 'staff_role_changed': return ['s:' + idOf(e.code) + ':' + e.person];
    case 'staff_moved': return ['s:' + idOf(e.from.code) + ':' + e.person, 's:' + idOf(e.to.code) + ':' + e.person];
    default: return ['m:' + idOf(e.code)];
  }
}
function evView(e) {
  const room = (code, name) => memberLink(code, name) + ' 의원실';
  switch (e.type) {
    case 'member_added': return ['＋ 추가', memberLink(e.code, e.name) + ' 의원이 명단에 추가됨 ' + pty(e.party)];
    case 'member_removed': return ['－ 제외', esc(e.name) + ' 의원이 명단에서 제외됨 ' + pty(e.party)];
    case 'field_changed': {
      const f = (v) => (e.field === '정당' ? (v ? pty(v) : '없음') : esc(v || '없음'));
      return ['↻ 변경', memberLink(e.code, e.name) + ' 의원 ' + esc(e.field) + ': ' + f(e.from) + ' → ' + f(e.to)];
    }
    case 'committee_added': return ['＋ 추가', memberLink(e.code, e.name) + ' 의원 소속 위원회에 ' + esc(e.committee) + ' 추가'];
    case 'committee_removed': return ['－ 제외', memberLink(e.code, e.name) + ' 의원 소속 위원회에서 ' + esc(e.committee) + ' 제외'];
    case 'staff_added': return ['＋ 추가', '<b>' + esc(e.person) + '</b> (' + esc(e.role) + ') — ' + room(e.code, e.name) + '에 추가'];
    case 'staff_removed': return ['－ 제외', '<b>' + esc(e.person) + '</b> (' + esc(e.role) + ') — ' + room(e.code, e.name) + '에서 제외'];
    case 'staff_moved': return ['→ 이동', '<b>' + esc(e.person) + '</b>: ' + room(e.from.code, e.from.name) + ' (' + esc(e.from.role) + ') → ' + room(e.to.code, e.to.name) + ' (' + esc(e.to.role) + ')'];
    case 'staff_role_changed': return ['↻ 변경', '<b>' + esc(e.person) + '</b> — ' + room(e.code, e.name) + ' ' + esc(e.from_role) + ' → ' + esc(e.to_role)];
    default: return ['변경', esc(JSON.stringify(e))];
  }
}
function daySummary(events) {
  const c = { add: 0, rem: 0, mov: 0, chg: 0, mem: 0 };
  events.forEach((e) => {
    if (e.type === 'staff_added') c.add++; else if (e.type === 'staff_removed') c.rem++; else if (e.type === 'staff_moved') c.mov++;
    else if (e.type === 'staff_role_changed') c.chg++; else c.mem++;
  });
  const parts = [];
  if (c.add) parts.push('보좌진 추가 ' + c.add); if (c.rem) parts.push('제외 ' + c.rem); if (c.mov) parts.push('이동 ' + c.mov);
  if (c.chg) parts.push('직급 변경 ' + c.chg); if (c.mem) parts.push('의원·위원회 등 변경 ' + c.mem);
  return parts.join(' · ');
}
function changesHtml() {
  const seen = lsGet(LS_SEEN) || '';
  const label = mode === 'team' ? '팀이 아는 사람 관련만' : '내가 아는 사람 관련만';
  let html = '<section class="changes" id="changes"><div class="chghead"><h2>인력 변동 안내</h2>'
    + '<label class="chk"><input type="checkbox" id="chgKnown"' + (chgOnly ? ' checked' : '') + '> ' + label + '</label></div>'
    + '<p class="hint" style="margin:0 0 12px">' + (meta.updatedAt ? '마지막 갱신 ' + esc(fmtTime(meta.updatedAt)) + '. ' : '')
    + '매일 오전 9시에 어제와 비교해 달라진 점을 기록합니다.' + (meta.baselineDate ? ' (기준 데이터 ' + esc(meta.baselineDate) + ')' : '') + '</p>';
  let shownDays = 0;
  changes.forEach((day, i) => {
    const evs = day.events.filter((e) => !chgOnly || evKeys(e).some(isKnown));
    if (!evs.length) return;
    shownDays++;
    const isNew = day.date > seen;
    html += '<details class="day"' + (shownDays === 1 || isNew ? ' open' : '') + '><summary><span class="date">' + esc(day.date) + '</span>'
      + '<span class="sum">' + esc(daySummary(evs)) + '</span>' + (isNew ? '<span class="chip known">새 변동</span>' : '') + '</summary><ul class="evlist">'
      + evs.map((e) => {
        const [tag, tx] = evView(e), k = evKeys(e).some(isKnown);
        return '<li class="ev' + (k ? ' known' : '') + '"><span class="tag">' + tag + '</span><span class="tx">' + (k ? '★ ' : '') + tx + '</span></li>';
      }).join('') + '</ul></details>';
  });
  if (!shownDays) {
    html += '<div class="empty-state">' + (chgOnly ? '아는 사람과 관련된 변동이 없습니다.'
      : meta.updatedAt ? '아직 기록된 변동이 없습니다. 내일부터 어제와 달라진 점이 여기에 표시됩니다.' : '첫 갱신 후 변동 내역이 여기에 표시됩니다.') + '</div>';
  }
  return html + '</section>';
}
let observer = null;
function watchChanges() {
  if (observer) { observer.disconnect(); observer = null; }
  const el = document.getElementById('changes');
  if (!el || !changes.length || !('IntersectionObserver' in window)) return;
  observer = new IntersectionObserver((entries) => {
    if (entries.some((x) => x.isIntersecting && x.intersectionRatio >= 0.3)) { lsSet(LS_SEEN, changes[0].date); observer.disconnect(); }
  }, { threshold: [0.3] });
  observer.observe(el);
}

/* ---------- 라우팅·이벤트 ---------- */
function render(keep) {
  const h = location.hash.slice(1);
  let m = null;
  if (h.indexOf('m-') === 0) { const id = h.slice(2); m = memberById[id] || null; }
  $('#chgLink').hidden = !!m; // 변동 안내는 첫 페이지에서만
  if (m) renderMember(m, keep === true);
  else {
    renderHome();
    if (h === 'changes') { const el = document.getElementById('changes'); if (el) el.scrollIntoView(); }
  }
}
function toList() { if (location.hash) location.hash = ''; else render(); }

$('#q').addEventListener('input', (e) => { query = e.target.value; lastQuery = query; toList(); });
$('#party').addEventListener('change', (e) => { party = e.target.value; toList(); });
$('#onlyKnown').addEventListener('change', () => toList());
$('#mPersonal').addEventListener('click', () => setMode('personal'));
$('#mTeam').addEventListener('click', () => setMode('team'));
$('#authBtn').addEventListener('click', () => { authOpen = !authOpen; if (!authOpen) authMsg = ''; renderAuth(); });
$('#authpanel').addEventListener('submit', (e) => {
  e.preventDefault();
  if (e.target.id === 'loginForm') signIn($('#email').value.trim());
  else if (e.target.id === 'nameForm') saveName($('#nameIn').value.trim());
});
$('#authpanel').addEventListener('click', async (e) => {
  if (e.target.id !== 'logout') return;
  await sb.auth.signOut(); authOpen = false; authMsg = ''; await onSession(null);
});
$('#view').addEventListener('input', (e) => {
  const t = e.target;
  if (t.classList && t.classList.contains('memo')) setMemo(t.getAttribute('data-memo'), t.value);
  if (t.id === 'chgKnown') { chgOnly = t.checked; render(true); }
});
$('#view').addEventListener('change', (e) => { if (e.target.id === 'chgKnown') { chgOnly = e.target.checked; render(true); } });
$('#view').addEventListener('click', (e) => {
  const kb = e.target.closest('[data-known]');
  if (kb) {
    const key = kb.getAttribute('data-known'); toggleMine(key); render(true);
    if (myMarks.has(key)) {
      const inp = document.querySelector('.memo[data-memo="' + (window.CSS && CSS.escape ? CSS.escape(key) : key) + '"]');
      if (inp) inp.focus({ preventScroll: true });
    }
    return;
  }
  const b = e.target.closest('[data-search]'); if (!b) return;
  query = b.getAttribute('data-search'); lastQuery = query; $('#q').value = query;
  if (location.hash) location.hash = ''; else render();
  window.scrollTo(0, 0);
});
window.addEventListener('hashchange', () => render());

/* ---------- 시작 ---------- */
(async function init() {
  useLocalCache(); rebuildKmap(); applyModeUi(); renderAuth();
  await loadData();
  if (mode === 'team') mode = 'personal'; // 로그인 확인 전에는 개인 모드로 시작
  applyModeUi(); render();
  if (CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY && window.supabase && window.supabase.createClient) {
    try {
      const url = String(CFG.SUPABASE_URL).trim().replace(/\/(auth|rest)\/v1.*$/i, '').replace(/\/+$/, '');
      if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|com)$/i.test(url)) {
        setStatus('config.js의 SUPABASE_URL 형식이 이상합니다. https://프로젝트이름.supabase.co 형태여야 합니다. (현재 값: ' + url + ')', true);
      }
      sb = window.supabase.createClient(url, String(CFG.SUPABASE_ANON_KEY).trim(), { auth: { flowType: 'pkce', persistSession: true, detectSessionInUrl: true } });
      await initAuth();
      if (lsGet(LS_MODE) === 'team' && me) setMode('team');
    } catch (e) { sb = null; setStatus('팀 기능에 연결하지 못했습니다: ' + e.message, true); }
  }
  renderAuth();
  setInterval(pollTeam, 60000);
  document.addEventListener('visibilitychange', pollTeam);
})();
})();
