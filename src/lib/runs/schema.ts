export const schemaSql = `
pragma foreign_keys = on;

create table if not exists runs (
  id text primary key,
  pr_url text not null,
  owner text not null,
  repo text not null,
  pull_number integer not null,
  status text not null check (status in ('running', 'complete', 'failed')),
  current_stage text not null,
  model text,
  started_at text not null,
  completed_at text,
  error_message text
);

create index if not exists runs_started_at_idx on runs(started_at desc);
create index if not exists runs_pr_idx on runs(owner, repo, pull_number, started_at desc);

create table if not exists run_events (
  id integer primary key autoincrement,
  run_id text not null references runs(id) on delete cascade,
  seq integer not null,
  ts text not null,
  stage text,
  agent text,
  event_type text not null,
  label text,
  detail text,
  payload_json text not null,
  unique(run_id, seq)
);

create index if not exists run_events_run_seq_idx on run_events(run_id, seq);

create table if not exists tool_calls (
  id text primary key,
  run_id text not null references runs(id) on delete cascade,
  event_id integer not null references run_events(id) on delete cascade,
  agent text not null,
  tool_name text not null,
  args_json text not null,
  status text not null check (status in ('running', 'complete', 'failed')),
  started_at text not null,
  completed_at text,
  result_summary text,
  error_message text
);

create index if not exists tool_calls_run_agent_idx on tool_calls(run_id, agent, started_at desc);

create table if not exists triage_reports (
  run_id text primary key references runs(id) on delete cascade,
  status text not null,
  summary text not null,
  report_markdown text not null,
  root_cause text not null,
  confidence text not null,
  failure_type text not null,
  approval_required integer not null
);

create table if not exists evidence_items (
  id integer primary key autoincrement,
  run_id text not null references runs(id) on delete cascade,
  source text not null,
  detail text not null
);

create index if not exists evidence_items_run_idx on evidence_items(run_id);

create table if not exists suspected_files (
  id integer primary key autoincrement,
  run_id text not null references runs(id) on delete cascade,
  path text not null
);

create index if not exists suspected_files_run_idx on suspected_files(run_id);

create table if not exists patch_plan_steps (
  id integer primary key autoincrement,
  run_id text not null references runs(id) on delete cascade,
  position integer not null,
  step text not null
);

create index if not exists patch_plan_steps_run_idx on patch_plan_steps(run_id, position);

create table if not exists safe_commands (
  id integer primary key autoincrement,
  run_id text not null references runs(id) on delete cascade,
  command text not null
);

create index if not exists safe_commands_run_idx on safe_commands(run_id);

create table if not exists patch_proposals (
  run_id text primary key references runs(id) on delete cascade,
  status text not null,
  summary text not null,
  diff text not null,
  explanation text not null,
  confidence text not null,
  caveats_json text not null
);

create table if not exists patch_files (
  id integer primary key autoincrement,
  run_id text not null references runs(id) on delete cascade,
  path text not null
);

create index if not exists patch_files_run_idx on patch_files(run_id);

create table if not exists review_verdicts (
  run_id text primary key references runs(id) on delete cascade,
  verdict text not null,
  summary text not null,
  recommendation text not null,
  confidence text not null
);

create table if not exists review_concerns (
  id integer primary key autoincrement,
  run_id text not null references runs(id) on delete cascade,
  severity text not null,
  description text not null
);

create index if not exists review_concerns_run_idx on review_concerns(run_id);
`;
