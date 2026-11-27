-- Supabase 대시보드 > SQL Editor 에 통째로 붙여 넣고 Run 하세요. (한 번만)
--
-- 저장하는 것
--   profiles : 팀원이 정한 표시 이름 (모든 팀원이 볼 수 있음)
--   marks    : "내가 아는 사람" 표시 (모든 팀원이 볼 수 있음 → 팀 모드에서 합쳐 보임)
--   memos    : 메모 (본인만 볼 수 있음)
-- key 형식: 의원 'm:<의원코드>' / 보좌진 's:<의원코드>:<이름>'

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 20),
  updated_at timestamptz not null default now()
);

create table if not exists public.marks (
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null check (char_length(key) <= 200),
  created_at timestamptz not null default now(),
  primary key (user_id, key)
);

create table if not exists public.memos (
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null check (char_length(key) <= 200),
  memo text not null check (char_length(memo) <= 500),
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

alter table public.profiles enable row level security;
alter table public.marks    enable row level security;
alter table public.memos    enable row level security;

-- profiles: 로그인한 팀원은 모두 읽고, 자기 것만 쓴다
drop policy if exists "profiles_read"   on public.profiles;
drop policy if exists "profiles_insert" on public.profiles;
drop policy if exists "profiles_update" on public.profiles;
create policy "profiles_read"   on public.profiles for select to authenticated using (true);
create policy "profiles_insert" on public.profiles for insert to authenticated with check (user_id = auth.uid());
create policy "profiles_update" on public.profiles for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- marks: 로그인한 팀원은 모두 읽고, 자기 표시만 추가·삭제한다
drop policy if exists "marks_read"   on public.marks;
drop policy if exists "marks_insert" on public.marks;
drop policy if exists "marks_delete" on public.marks;
create policy "marks_read"   on public.marks for select to authenticated using (true);
create policy "marks_insert" on public.marks for insert to authenticated with check (user_id = auth.uid());
create policy "marks_delete" on public.marks for delete to authenticated using (user_id = auth.uid());

-- memos: 본인 것만 읽고 쓴다 (다른 팀원에게는 보이지 않음)
drop policy if exists "memos_own_select" on public.memos;
drop policy if exists "memos_own_insert" on public.memos;
drop policy if exists "memos_own_update" on public.memos;
drop policy if exists "memos_own_delete" on public.memos;
create policy "memos_own_select" on public.memos for select to authenticated using (user_id = auth.uid());
create policy "memos_own_insert" on public.memos for insert to authenticated with check (user_id = auth.uid());
create policy "memos_own_update" on public.memos for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "memos_own_delete" on public.memos for delete to authenticated using (user_id = auth.uid());

-- 로그인하지 않은 사람(anon)에게는 아무 권한도 주지 않는다
revoke all on public.profiles, public.marks, public.memos from anon;
grant select, insert, update, delete on public.profiles, public.marks, public.memos to authenticated;
