import { randomUUID } from "node:crypto";
import { defaultModel } from "@/lib/gitagent";
import type { PipelineEvent } from "@/lib/pipeline";
import type { PullRequestRef } from "@/lib/pr-url";
import type {
  PatchProposal,
  PipelineResult,
  ReviewVerdict,
  TimelineEvent,
  TriageReport,
} from "@/lib/types";
import { getDb } from "./db";

type RunStatus = "running" | "complete" | "failed";

export type RunSummary = {
  id: string;
  prUrl: string;
  owner: string;
  repo: string;
  pullNumber: number;
  status: RunStatus;
  currentStage: string;
  model: string | null;
  startedAt: string;
  completedAt: string | null;
  errorMessage: string | null;
  summary: string | null;
  confidence: string | null;
  failureType: string | null;
  verdict: string | null;
};

export type StoredRun = RunSummary & {
  result: PipelineResult | null;
  events: StoredRunEvent[];
};

export type StoredRunEvent = {
  id: number;
  seq: number;
  ts: string;
  stage: string | null;
  agent: string | null;
  eventType: string;
  label: string | null;
  detail: string | null;
  payload: unknown;
};

type RunRow = {
  id: string;
  pr_url: string;
  owner: string;
  repo: string;
  pull_number: number;
  status: RunStatus;
  current_stage: string;
  model: string | null;
  started_at: string;
  completed_at: string | null;
  error_message: string | null;
  summary: string | null;
  confidence: string | null;
  failure_type: string | null;
  verdict: string | null;
};

type EventRow = {
  id: number;
  seq: number;
  ts: string;
  stage: string | null;
  agent: string | null;
  event_type: string;
  label: string | null;
  detail: string | null;
  payload_json: string;
};

export function createRun(prUrl: string, ref: PullRequestRef) {
  const id = randomUUID();
  const now = new Date().toISOString();

  getDb()
    .prepare(
      `insert into runs (id, pr_url, owner, repo, pull_number, status, current_stage, model, started_at)
       values (?, ?, ?, ?, ?, 'running', 'accepted', ?, ?)`,
    )
    .run(
      id,
      prUrl,
      ref.owner,
      ref.repo,
      ref.pullNumber,
      process.env.BUILDMEDIC_MODEL ?? defaultModel(),
      now,
    );

  return id;
}

export function recordPipelineEvent(runId: string, event: PipelineEvent) {
  const db = getDb();
  const inserted = insertEvent(
    runId,
    eventLabel(event),
    eventDetail(event),
    eventType(event),
    eventAgent(event),
    eventStage(event),
    event,
  );

  if (event.type === "stage") {
    db.prepare("update runs set current_stage = ? where id = ?").run(
      `${event.stage}:${event.status}`,
      runId,
    );
  }

  if (event.type === "tool") {
    db.prepare(
      `insert into tool_calls (id, run_id, event_id, agent, tool_name, args_json, status, started_at)
       values (?, ?, ?, ?, ?, ?, 'running', ?)`,
    ).run(
      randomUUID(),
      runId,
      inserted.id,
      event.agent,
      event.name,
      stringifyJson(event.args ?? {}),
      new Date().toISOString(),
    );
  }

  if (event.type === "tool_result") {
    db.prepare(
      `update tool_calls
       set status = 'complete', completed_at = ?, result_summary = ?
       where id = (
         select id from tool_calls
         where run_id = ? and agent = ? and status = 'running'
         order by started_at desc
         limit 1
       )`,
    ).run(new Date().toISOString(), event.message, runId, event.agent ?? "");
  }

  if (event.type === "error") {
    db.prepare(
      `update tool_calls
       set status = 'failed', completed_at = ?, error_message = ?
       where id = (
         select id from tool_calls
         where run_id = ? and agent = ? and status = 'running'
         order by started_at desc
         limit 1
       )`,
    ).run(new Date().toISOString(), event.message, runId, event.agent ?? "");
  }
}

export function completeRun(runId: string, result: PipelineResult) {
  const db = getDb();

  db.transaction(() => {
    clearResultRows(runId);
    insertTriage(runId, result.triage);
    if (result.patch) insertPatch(runId, result.patch);
    if (result.review) insertReview(runId, result.review);

    db.prepare(
      `update runs
       set status = 'complete', current_stage = ?, completed_at = ?, error_message = null
       where id = ?`,
    ).run(result.pipelineStage, new Date().toISOString(), runId);
  })();
}

export function failRun(runId: string, error: unknown) {
  getDb()
    .prepare(
      `update runs
       set status = 'failed', current_stage = 'failed', completed_at = ?, error_message = ?
       where id = ?`,
    )
    .run(
      new Date().toISOString(),
      error instanceof Error ? error.message : String(error),
      runId,
    );
}

export function listRuns(limit = 20): RunSummary[] {
  const rows = getDb()
    .prepare(
      `select r.*, t.summary, t.confidence, t.failure_type, v.verdict
       from runs r
       left join triage_reports t on t.run_id = r.id
       left join review_verdicts v on v.run_id = r.id
       order by r.started_at desc
       limit ?`,
    )
    .all(Math.max(1, Math.min(Math.trunc(limit), 100))) as RunRow[];

  return rows.map(toRunSummary);
}

export function getRun(id: string): StoredRun | null {
  const row = getDb()
    .prepare(
      `select r.*, t.summary, t.confidence, t.failure_type, v.verdict
       from runs r
       left join triage_reports t on t.run_id = r.id
       left join review_verdicts v on v.run_id = r.id
       where r.id = ?`,
    )
    .get(id) as RunRow | undefined;

  if (!row) return null;

  const events = listRunEvents(id);
  return {
    ...toRunSummary(row),
    events,
    result: buildResult(id, events),
  };
}

export function deleteRun(id: string) {
  const result = getDb().prepare("delete from runs where id = ?").run(id);
  return result.changes > 0;
}

function insertEvent(
  runId: string,
  label: string | null,
  detail: string | null,
  type: string,
  agent: string | null,
  stage: string | null,
  payload: unknown,
) {
  const db = getDb();
  const seq = (
    db
      .prepare(
        "select coalesce(max(seq), 0) + 1 as next_seq from run_events where run_id = ?",
      )
      .get(runId) as { next_seq: number }
  ).next_seq;
  const result = db
    .prepare(
      `insert into run_events (run_id, seq, ts, stage, agent, event_type, label, detail, payload_json)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      runId,
      seq,
      new Date().toISOString(),
      stage,
      agent,
      type,
      label,
      detail,
      stringifyJson(payload),
    );

  return { id: Number(result.lastInsertRowid), seq };
}

function clearResultRows(runId: string) {
  const db = getDb();
  for (const table of [
    "review_concerns",
    "review_verdicts",
    "patch_files",
    "patch_proposals",
    "safe_commands",
    "patch_plan_steps",
    "suspected_files",
    "evidence_items",
    "triage_reports",
  ]) {
    db.prepare(`delete from ${table} where run_id = ?`).run(runId);
  }
}

function insertTriage(runId: string, triage: TriageReport) {
  const db = getDb();
  db.prepare(
    `insert into triage_reports
     (run_id, status, summary, report_markdown, root_cause, confidence, failure_type, approval_required)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    runId,
    triage.status,
    triage.summary,
    triage.reportMarkdown,
    triage.rootCause,
    triage.confidence,
    triage.failureType,
    triage.approvalRequired ? 1 : 0,
  );

  const evidence = db.prepare(
    "insert into evidence_items (run_id, source, detail) values (?, ?, ?)",
  );
  for (const item of triage.evidence)
    evidence.run(runId, item.source, item.detail);

  const suspected = db.prepare(
    "insert into suspected_files (run_id, path) values (?, ?)",
  );
  for (const file of triage.suspectedFiles) suspected.run(runId, file);

  const steps = db.prepare(
    "insert into patch_plan_steps (run_id, position, step) values (?, ?, ?)",
  );
  triage.patchPlan.forEach((step, index) => steps.run(runId, index + 1, step));

  const commands = db.prepare(
    "insert into safe_commands (run_id, command) values (?, ?)",
  );
  for (const command of triage.safeCommands) commands.run(runId, command);
}

function insertPatch(runId: string, patch: PatchProposal) {
  const db = getDb();
  db.prepare(
    `insert into patch_proposals
     (run_id, status, summary, diff, explanation, confidence, caveats_json)
     values (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    runId,
    patch.status,
    patch.summary,
    patch.diff,
    patch.explanation,
    patch.confidence,
    stringifyJson(patch.caveats),
  );

  const files = db.prepare(
    "insert into patch_files (run_id, path) values (?, ?)",
  );
  for (const file of patch.filesModified) files.run(runId, file);
}

function insertReview(runId: string, review: ReviewVerdict) {
  const db = getDb();
  db.prepare(
    `insert into review_verdicts
     (run_id, verdict, summary, recommendation, confidence)
     values (?, ?, ?, ?, ?)`,
  ).run(
    runId,
    review.verdict,
    review.summary,
    review.recommendation,
    review.confidence,
  );

  const concerns = db.prepare(
    "insert into review_concerns (run_id, severity, description) values (?, ?, ?)",
  );
  for (const concern of review.concerns)
    concerns.run(runId, concern.severity, concern.description);
}

function buildResult(
  runId: string,
  events: StoredRunEvent[],
): PipelineResult | null {
  const triage = getTriage(runId, events);
  if (!triage) return null;

  return {
    triage,
    patch: getPatch(runId, events) ?? undefined,
    review: getReview(runId, events) ?? undefined,
    pipelineStage: "complete",
  };
}

function getTriage(
  runId: string,
  events: StoredRunEvent[],
): TriageReport | null {
  const row = getDb()
    .prepare("select * from triage_reports where run_id = ?")
    .get(runId) as
    | {
        status: TriageReport["status"];
        summary: string;
        report_markdown: string;
        root_cause: string;
        confidence: TriageReport["confidence"];
        failure_type: TriageReport["failureType"];
        approval_required: number;
      }
    | undefined;

  if (!row) return null;

  return {
    engine: "gitagent",
    status: row.status,
    summary: row.summary,
    reportMarkdown: row.report_markdown,
    rootCause: row.root_cause,
    confidence: row.confidence,
    failureType: row.failure_type,
    approvalRequired: Boolean(row.approval_required),
    evidence: getRows<{ source: string; detail: string }>(
      "select source, detail from evidence_items where run_id = ? order by id",
      runId,
    ),
    suspectedFiles: getRows<{ path: string }>(
      "select path from suspected_files where run_id = ? order by id",
      runId,
    ).map((row) => row.path),
    patchPlan: getRows<{ step: string }>(
      "select step from patch_plan_steps where run_id = ? order by position",
      runId,
    ).map((row) => row.step),
    safeCommands: getRows<{ command: string }>(
      "select command from safe_commands where run_id = ? order by id",
      runId,
    ).map((row) => row.command),
    timeline: timelineFor(events, "triage"),
  };
}

function getPatch(
  runId: string,
  events: StoredRunEvent[],
): PatchProposal | null {
  const row = getDb()
    .prepare("select * from patch_proposals where run_id = ?")
    .get(runId) as
    | {
        status: PatchProposal["status"];
        summary: string;
        diff: string;
        explanation: string;
        confidence: PatchProposal["confidence"];
        caveats_json: string;
      }
    | undefined;

  if (!row) return null;

  return {
    status: row.status,
    summary: row.summary,
    diff: row.diff,
    explanation: row.explanation,
    confidence: row.confidence,
    caveats: parseJson<string[]>(row.caveats_json, []),
    filesModified: getRows<{ path: string }>(
      "select path from patch_files where run_id = ? order by id",
      runId,
    ).map((row) => row.path),
    timeline: timelineFor(events, "patch"),
  };
}

function getReview(
  runId: string,
  events: StoredRunEvent[],
): ReviewVerdict | null {
  const row = getDb()
    .prepare("select * from review_verdicts where run_id = ?")
    .get(runId) as
    | {
        verdict: ReviewVerdict["verdict"];
        summary: string;
        recommendation: string;
        confidence: ReviewVerdict["confidence"];
      }
    | undefined;

  if (!row) return null;

  return {
    verdict: row.verdict,
    summary: row.summary,
    recommendation: row.recommendation,
    confidence: row.confidence,
    concerns: getRows<ReviewVerdict["concerns"][number]>(
      "select severity, description from review_concerns where run_id = ? order by id",
      runId,
    ),
    timeline: timelineFor(events, "review"),
  };
}

function listRunEvents(runId: string): StoredRunEvent[] {
  const rows = getDb()
    .prepare("select * from run_events where run_id = ? order by seq")
    .all(runId) as EventRow[];

  return rows.map((row) => ({
    id: row.id,
    seq: row.seq,
    ts: row.ts,
    stage: row.stage,
    agent: row.agent,
    eventType: row.event_type,
    label: row.label,
    detail: row.detail,
    payload: parseJson(row.payload_json, null),
  }));
}

function timelineFor(events: StoredRunEvent[], agent: string): TimelineEvent[] {
  return events
    .filter((event) => event.agent === agent && event.label)
    .map((event) => ({
      label: event.label ?? event.eventType,
      detail: event.detail ?? "",
    }));
}

function getRows<T>(sql: string, runId: string) {
  return getDb().prepare(sql).all(runId) as T[];
}

function toRunSummary(row: RunRow): RunSummary {
  return {
    id: row.id,
    prUrl: row.pr_url,
    owner: row.owner,
    repo: row.repo,
    pullNumber: row.pull_number,
    status: row.status,
    currentStage: row.current_stage,
    model: row.model,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    errorMessage: row.error_message,
    summary: row.summary,
    confidence: row.confidence,
    failureType: row.failure_type,
    verdict: row.verdict,
  };
}

function eventType(event: PipelineEvent) {
  return event.type;
}

function eventAgent(event: PipelineEvent) {
  return "agent" in event ? event.agent : null;
}

function eventStage(event: PipelineEvent) {
  if (event.type === "stage") return event.stage;
  return null;
}

function eventLabel(event: PipelineEvent) {
  if (event.type === "stage") return `${title(event.stage)} ${event.status}`;
  if (event.type === "tool") return `Tool: ${event.name}`;
  if (event.type === "tool_result") return "Tool result";
  if (event.type === "timeline") return event.item.label;
  if (event.type === "final") return "Final report";
  if (event.type === "status" || event.type === "error") return event.message;
  return "Event";
}

function eventDetail(event: PipelineEvent) {
  if (event.type === "stage") return `Stage ${event.stage} is ${event.status}.`;
  if (event.type === "tool") return stringifyJson(event.args ?? {});
  if (event.type === "tool_result") return event.message;
  if (event.type === "timeline") return event.item.detail;
  if (event.type === "final") return event.report.summary;
  if (event.type === "status" || event.type === "error") return event.message;
  return "";
}

function title(value: string) {
  return value.slice(0, 1).toUpperCase() + value.slice(1).replaceAll("_", " ");
}

function stringifyJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ unavailable: true });
  }
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
