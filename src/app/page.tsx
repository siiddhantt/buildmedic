"use client";

import {
  Fragment,
  FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import {
  ActivityIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  FileTextIcon,
  Loader2Icon,
  PlayIcon,
  SearchIcon,
  ShieldCheckIcon,
  TerminalIcon,
  Trash2Icon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import type {
  PipelineResult,
  TriageReport,
  PatchProposal,
  ReviewVerdict,
} from "@/lib/types";

const samplePrUrl = "https://github.com/owner/repo/pull/123";

type PipelineStage =
  | "idle"
  | "triage"
  | "patching"
  | "reviewing"
  | "complete"
  | "failed";

type LiveEventKind = "status" | "tool" | "tool_result" | "error" | "stage";

type LiveEvent = {
  id: string;
  kind: LiveEventKind;
  agent?: string;
  label: string;
  detail: string;
  time: string;
};

type RunSummary = {
  id: string;
  prUrl: string;
  owner: string;
  repo: string;
  pullNumber: number;
  status: "running" | "complete" | "failed";
  currentStage: string;
  startedAt: string;
  errorMessage: string | null;
  summary: string | null;
  confidence: string | null;
  failureType: string | null;
  verdict: string | null;
};

type StoredRunEvent = {
  id: number;
  ts: string;
  agent: string | null;
  eventType: string;
  label: string | null;
  detail: string | null;
};

export default function Home() {
  const [prUrl, setPrUrl] = useState("");
  const [activeRunId, setActiveRunId] = useState("");
  const [recentRuns, setRecentRuns] = useState<RunSummary[]>([]);
  const [pipeline, setPipeline] = useState<PipelineResult | null>(null);
  const [error, setError] = useState("");
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [openEvents, setOpenEvents] = useState<string[]>([]);
  const [status, setStatus] = useState("Idle");
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState<PipelineStage>("idle");
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const canSubmit = useMemo(
    () => prUrl.trim().length > 0 && !loading,
    [prUrl, loading],
  );

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: "end" });
  }, [events]);

  useEffect(() => {
    refreshRuns();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setActiveRunId("");
    setLoading(true);
    setError("");
    setPipeline(null);
    setEvents([]);
    setOpenEvents([]);
    setStatus("Starting pipeline...");
    setStage("triage");

    try {
      const response = await fetch("/api/triage/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prUrl }),
      });

      if (!response.body)
        throw new Error("Streaming response was unavailable.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";

        for (const chunk of chunks) handleStreamChunk(chunk);
      }
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "Unable to run pipeline.";
      setError(message);
      setStatus("Stopped");
      setStage("failed");
      appendEvent("error", "Stopped", message);
    } finally {
      setLoading(false);
    }
  }

  async function refreshRuns() {
    const response = await fetch("/api/runs");
    if (!response.ok) return;
    const payload = (await response.json()) as { runs: RunSummary[] };
    setRecentRuns(payload.runs);
  }

  async function loadRun(id: string) {
    setLoading(true);
    setError("");

    try {
      const response = await fetch(`/api/runs/${id}`);
      if (!response.ok) throw new Error("Unable to load run.");
      const payload = (await response.json()) as {
        run: RunSummary & {
          result: PipelineResult | null;
          events: StoredRunEvent[];
        };
      };

      setActiveRunId(payload.run.id);
      setPrUrl(payload.run.prUrl);
      setPipeline(payload.run.result);
      setEvents(payload.run.events.map(storedEventToLiveEvent));
      setOpenEvents(
        payload.run.events.slice(-6).map((item) => `stored-${item.id}`),
      );
      setStatus(
        payload.run.status === "failed"
          ? "Run failed"
          : payload.run.result
            ? "Loaded saved run"
            : "Loaded run",
      );
      setStage(
        payload.run.status === "failed"
          ? "failed"
          : payload.run.result
            ? "complete"
            : "idle",
      );
      setError(payload.run.errorMessage ?? "");
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "Unable to load run.";
      setError(message);
      appendEvent("error", "Load failed", message);
    } finally {
      setLoading(false);
    }
  }

  async function deleteSavedRun(id: string) {
    const response = await fetch(`/api/runs/${id}`, { method: "DELETE" });
    if (!response.ok) {
      appendEvent("error", "Delete failed", "Unable to delete saved workflow.");
      return;
    }

    if (id === activeRunId) {
      setActiveRunId("");
      setPipeline(null);
      setEvents([]);
      setOpenEvents([]);
      setStatus("Idle");
      setStage("idle");
      setError("");
    }

    await refreshRuns();
  }

  function handleStreamChunk(chunk: string) {
    const eventLine = chunk
      .split("\n")
      .find((line) => line.startsWith("event: "));
    const dataLine = chunk
      .split("\n")
      .find((line) => line.startsWith("data: "));
    if (!dataLine) return;

    const eventType = eventLine?.slice(7);
    const payload = JSON.parse(dataLine.slice(6));
    const type = String(payload.type ?? eventType ?? "");
    const agent = payload.agent as string | undefined;

    if (eventType === "run") {
      setActiveRunId(String(payload.runId ?? ""));
      return;
    }

    if (type === "final") {
      setPipeline(payload.result);
      setActiveRunId(String(payload.runId ?? activeRunId));
      setStatus("Pipeline complete");
      setStage("complete");
      appendEvent(
        "status",
        "Pipeline complete",
        "All agents finished. No repository state changed.",
        agent,
      );
      refreshRuns();
      return;
    }

    if (type === "stage") {
      const stageId = String(payload.stage ?? "");
      const stageStatus = String(payload.status ?? "");
      if (stageId && stageStatus === "running") {
        setStage(stageId as PipelineStage);
        const labels: Record<string, string> = {
          triage: "Triage Agent",
          patching: "Patch Agent",
          reviewing: "Review Agent",
        };
        setStatus(`${labels[stageId] ?? stageId} running...`);
        appendEvent(
          "stage",
          `${labels[stageId] ?? stageId} started`,
          `Stage: ${stageId}`,
          agent,
        );
      }
      return;
    }

    if (type === "error") {
      const message = String(payload.message ?? "Unable to run pipeline.");
      if (payload.runId) setActiveRunId(String(payload.runId));
      setError(message);
      setStatus("Stopped");
      appendEvent("error", "Stopped", message, agent);
      refreshRuns();
      return;
    }

    if (type === "tool") {
      const name = String(payload.name ?? "unknown");
      const agentLabel = agent ? `[${agent}] ` : "";
      setStatus(`${agentLabel}Running ${name}`);
      appendEvent(
        "tool",
        `${agentLabel}Tool: ${name}`,
        JSON.stringify(payload.args ?? {}, null, 2),
        agent,
      );
      return;
    }

    if (type === "tool_result") {
      appendEvent(
        "tool_result",
        "Tool result",
        String(payload.message ?? ""),
        agent,
      );
      return;
    }

    if (payload.message) {
      const message = String(payload.message);
      setStatus(message);
      appendEvent("status", "Status", message, agent);
    }
  }

  function appendEvent(
    kind: LiveEventKind,
    label: string,
    detail: string,
    agent?: string,
  ) {
    const item: LiveEvent = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      kind,
      agent,
      label,
      detail,
      time: new Intl.DateTimeFormat("en", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(new Date()),
    };
    setEvents((items) => [...items, item]);
    setOpenEvents((items) => [...items, item.id].slice(-6));
  }

  return (
    <main className="h-svh overflow-hidden bg-muted/35 text-foreground">
      <div className="mx-auto flex h-full min-h-0 w-full max-w-[1500px] flex-col gap-3 px-4 py-4 sm:px-6">
        <header className="flex shrink-0 items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <div className="relative">
                <ActivityIcon className="size-5 text-primary" />
                <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-emerald-500 ring-2 ring-background animate-pulse" />
              </div>
              <h1 className="truncate text-2xl font-bold tracking-tight text-foreground">
                BuildMedic
              </h1>
            </div>
            <p className="mt-1 text-sm font-medium text-muted-foreground">
              Multi-agent CI failure pipeline — Triage, Patch, Review.
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1.5 mt-0.5">
            <Badge variant="outline" className="hidden sm:inline-flex">
              v0.1 proof of concept
            </Badge>
            <a
              href="https://github.com/siiddhantt"
              target="_blank"
              rel="noreferrer"
              className="hidden items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-primary sm:inline-flex"
            >
              <svg
                className="size-3.5"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
              </svg>
              @siiddhantt
            </a>
          </div>
        </header>

        <Card size="sm" className="shrink-0 rounded-lg">
          <CardContent className="grid gap-3 px-3 lg:grid-cols-[minmax(0,1fr)_auto_minmax(220px,300px)] lg:items-end">
            <form
              className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_auto]"
              onSubmit={submit}
            >
              <label className="min-w-0 space-y-1.5">
                <span className="text-xs font-semibold uppercase text-muted-foreground">
                  Pull request URL
                </span>
                <Input
                  value={prUrl}
                  onChange={(event) => setPrUrl(event.target.value)}
                  placeholder={samplePrUrl}
                  className="h-10 bg-background text-sm font-medium"
                />
              </label>
              <Button disabled={!canSubmit} size="lg" className="h-10 self-end">
                {loading ? (
                  <Loader2Icon
                    className="animate-spin"
                    data-icon="inline-start"
                  />
                ) : (
                  <PlayIcon data-icon="inline-start" />
                )}
                {loading ? "Running..." : "Run pipeline"}
              </Button>
            </form>

            <Separator
              orientation="vertical"
              className="hidden h-12 lg:block"
            />

            <div className="min-w-0 border-t pt-3 lg:border-t-0 lg:pt-0">
              <div className="text-xs font-semibold uppercase text-muted-foreground">
                Status
              </div>
              <div className="mt-1 flex min-w-0 items-center gap-2">
                <StatusIcon
                  loading={loading}
                  error={Boolean(error)}
                  ready={Boolean(pipeline)}
                />
                <p className="truncate text-sm font-semibold text-foreground">
                  {status}
                </p>
              </div>
              {error ? (
                <p className="mt-1 line-clamp-2 text-xs font-medium text-destructive">
                  {error}
                </p>
              ) : null}
            </div>
          </CardContent>
        </Card>

        <RunHistory
          runs={recentRuns}
          activeRunId={activeRunId}
          onLoad={loadRun}
          onDelete={deleteSavedRun}
        />

        {(loading || stage !== "idle") && <PipelineStepper stage={stage} />}

        <section className="grid min-h-0 flex-1 grid-rows-[minmax(170px,34vh)_minmax(0,1fr)] gap-3 overflow-hidden lg:grid-cols-[minmax(300px,380px)_minmax(0,1fr)] lg:grid-rows-1">
          <LiveLogPane
            events={events}
            openEvents={openEvents}
            setOpenEvents={setOpenEvents}
            endRef={logEndRef}
          />
          <ReportPane pipeline={pipeline} loading={loading} />
        </section>
      </div>
    </main>
  );
}

const PIPELINE_STEPS = [
  { id: "triage" as const, label: "Triage", icon: SearchIcon },
  { id: "patching" as const, label: "Patch", icon: WrenchIcon },
  { id: "reviewing" as const, label: "Review", icon: ShieldCheckIcon },
  { id: "complete" as const, label: "Done", icon: CheckCircle2Icon },
];

const STAGE_ORDER: Record<string, number> = {
  idle: -1,
  triage: 0,
  patching: 1,
  reviewing: 2,
  complete: 3,
  failed: 3,
};

function PipelineStepper({ stage }: { stage: PipelineStage }) {
  const currentIndex = STAGE_ORDER[stage] ?? -1;

  return (
    <div className="flex shrink-0 items-center justify-center gap-1.5 sm:gap-2">
      {PIPELINE_STEPS.map((step, i) => {
        const stepIndex = STAGE_ORDER[step.id] ?? i;
        const isActive = step.id === stage;
        const isDone = currentIndex > stepIndex;
        const isFailed = stage === "failed" && stepIndex === currentIndex;

        return (
          <Fragment key={step.id}>
            <div
              className={cn(
                "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold transition-all sm:px-3 sm:py-1.5",
                isActive && "bg-primary/15 text-primary ring-1 ring-primary/30",
                isDone && "text-primary/80",
                isFailed &&
                  "bg-destructive/10 text-destructive ring-1 ring-destructive/30",
                !isActive && !isDone && !isFailed && "text-muted-foreground/40",
              )}
            >
              {isDone ? (
                <CheckCircle2Icon className="size-3.5" />
              ) : isActive ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <step.icon className="size-3.5" />
              )}
              <span className="hidden sm:inline">{step.label}</span>
            </div>
            {i < PIPELINE_STEPS.length - 1 && (
              <div
                className={cn(
                  "h-px w-4 transition-colors sm:w-6",
                  isDone ? "bg-primary/40" : "bg-border",
                )}
              />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

function StatusIcon({
  loading,
  error,
  ready,
}: {
  loading: boolean;
  error: boolean;
  ready: boolean;
}) {
  if (loading)
    return (
      <Loader2Icon className="size-4 shrink-0 animate-spin text-muted-foreground" />
    );
  if (error)
    return <CircleAlertIcon className="size-4 shrink-0 text-destructive" />;
  if (ready)
    return <CheckCircle2Icon className="size-4 shrink-0 text-primary" />;
  return <ActivityIcon className="size-4 shrink-0 text-muted-foreground" />;
}

const AGENT_COLORS: Record<string, string> = {
  triage: "bg-blue-500/15 text-blue-400 ring-blue-500/25",
  patch: "bg-amber-500/15 text-amber-400 ring-amber-500/25",
  review: "bg-violet-500/15 text-violet-400 ring-violet-500/25",
};

function AgentBadge({ agent }: { agent?: string }) {
  if (!agent) return null;
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase ring-1",
        AGENT_COLORS[agent] ?? "bg-muted text-muted-foreground ring-border",
      )}
    >
      {agent}
    </span>
  );
}

function RunHistory({
  runs,
  activeRunId,
  onLoad,
  onDelete,
}: {
  runs: RunSummary[];
  activeRunId: string;
  onLoad: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  if (!runs.length) return null;

  return (
    <div className="flex shrink-0 items-center gap-2 overflow-x-auto rounded-lg border bg-background px-3 py-2">
      <div className="shrink-0 text-xs font-semibold uppercase text-muted-foreground">
        Recent Runs
      </div>
      <div className="flex min-w-0 gap-2">
        {runs.slice(0, 8).map((run) => (
          <div
            key={run.id}
            className={cn(
              "group flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-1.5 text-xs font-medium transition-colors hover:bg-muted",
              activeRunId === run.id &&
                "border-primary/40 bg-primary/10 text-primary",
            )}
          >
            <button
              type="button"
              onClick={() => onLoad(run.id)}
              className="flex items-center gap-2 rounded px-1 text-left"
            >
              <span className="font-mono">
                {run.owner}/{run.repo}#{run.pullNumber}
              </span>
              <Badge
                variant={
                  run.status === "failed"
                    ? "destructive"
                    : run.status === "complete"
                      ? "secondary"
                      : "outline"
                }
                className="px-1.5 py-0 text-[10px]"
              >
                {run.status}
              </Badge>
            </button>
            <button
              type="button"
              aria-label={`Delete saved workflow for ${run.owner}/${run.repo} pull request ${run.pullNumber}`}
              onClick={() => onDelete(run.id)}
              className="grid size-6 place-items-center rounded text-muted-foreground opacity-70 transition-colors hover:bg-destructive/10 hover:text-destructive sm:opacity-0 sm:group-hover:opacity-100"
            >
              <Trash2Icon className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function LiveLogPane({
  events,
  openEvents,
  setOpenEvents,
  endRef,
}: {
  events: LiveEvent[];
  openEvents: string[];
  setOpenEvents: (value: string[]) => void;
  endRef: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <Card className="flex min-h-0 rounded-lg py-0">
      <CardHeader className="shrink-0 border-b py-3">
        <div className="flex items-center gap-2">
          <TerminalIcon className="size-4 text-muted-foreground" />
          <CardTitle className="text-sm font-semibold">
            Live Agent Log
          </CardTitle>
        </div>
        <CardDescription className="text-xs">
          {events.length
            ? `${events.length} streamed events`
            : "Waiting for a run"}
        </CardDescription>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 px-0">
        <ScrollArea className="h-full">
          <div className="space-y-2 p-3">
            {events.length ? (
              <Accordion
                multiple
                value={openEvents}
                onValueChange={setOpenEvents}
                className="gap-2"
              >
                {events.map((item) => (
                  <AccordionItem
                    key={item.id}
                    value={item.id}
                    className="rounded-lg border bg-background px-3 not-last:border-b"
                  >
                    <AccordionTrigger className="gap-3 py-2 text-left hover:no-underline">
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        <EventIcon kind={item.kind} />
                        <span className="truncate text-sm font-medium">
                          {item.label}
                        </span>
                        <AgentBadge agent={item.agent} />
                      </div>
                      <span className="hidden shrink-0 text-xs font-medium text-muted-foreground xl:inline">
                        {item.time}
                      </span>
                    </AccordionTrigger>
                    <AccordionContent className="pb-3">
                      <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 font-mono text-[12px] leading-5 text-muted-foreground">
                        {item.detail || "No details."}
                      </pre>
                    </AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>
            ) : (
              <div className="grid h-36 place-items-center rounded-lg border border-dashed border-muted-foreground/20 bg-background/30 p-4 text-center">
                <p className="text-sm font-medium text-muted-foreground/70">
                  Tool calls will stream here.
                </p>
              </div>
            )}
            <div ref={endRef} />
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

function storedEventToLiveEvent(item: StoredRunEvent): LiveEvent {
  return {
    id: `stored-${item.id}`,
    kind: storedEventKind(item.eventType),
    agent: item.agent ?? undefined,
    label: item.label ?? item.eventType,
    detail: item.detail ?? "",
    time: new Intl.DateTimeFormat("en", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(item.ts)),
  };
}

function storedEventKind(type: string): LiveEventKind {
  if (type === "tool") return "tool";
  if (type === "tool_result") return "tool_result";
  if (type === "stage") return "stage";
  if (type === "error") return "error";
  return "status";
}

function EventIcon({ kind }: { kind: LiveEventKind }) {
  if (kind === "error")
    return <CircleAlertIcon className="size-4 shrink-0 text-destructive" />;
  if (kind === "tool")
    return <TerminalIcon className="size-4 shrink-0 text-primary/70" />;
  if (kind === "tool_result")
    return <FileTextIcon className="size-4 shrink-0 text-emerald-500/70" />;
  if (kind === "stage")
    return <PlayIcon className="size-4 shrink-0 text-primary" />;
  return <ActivityIcon className="size-4 shrink-0 text-muted-foreground" />;
}

function ReportPane({
  pipeline,
  loading,
}: {
  pipeline: PipelineResult | null;
  loading: boolean;
}) {
  const report = pipeline?.triage;

  return (
    <Card className="flex min-h-0 rounded-lg py-0">
      <CardHeader className="shrink-0 border-b py-3">
        <CardTitle className="text-sm font-semibold">Pipeline Report</CardTitle>
        <CardDescription className="text-xs">
          {report
            ? "Multi-agent pipeline results from triage, patch, and review."
            : "No report yet"}
        </CardDescription>
        <CardAction>
          {report ? (
            <Badge
              variant={report.confidence === "high" ? "default" : "outline"}
              className="capitalize"
            >
              {report.confidence} confidence
            </Badge>
          ) : null}
        </CardAction>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 px-0">
        <ScrollArea className="h-full">
          {pipeline ? (
            <PipelineReportView pipeline={pipeline} />
          ) : (
            <EmptyState loading={loading} />
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

function EmptyState({ loading }: { loading: boolean }) {
  return (
    <div className="grid min-h-full place-items-center p-6">
      <div className="max-w-sm rounded-lg border border-dashed border-muted-foreground/20 bg-card/50 p-6 text-center">
        <div className="mx-auto mb-3 grid size-10 place-items-center rounded-lg border border-muted-foreground/15 bg-muted/50">
          {loading ? (
            <Loader2Icon className="size-5 animate-spin text-primary" />
          ) : (
            <FileTextIcon className="size-5 text-muted-foreground" />
          )}
        </div>
        <h2 className="text-base font-semibold">
          {loading ? "Pipeline running" : "Ready for a failing PR"}
        </h2>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          {loading
            ? "The report will appear when all agents finish."
            : "Paste a GitHub pull request URL and run the pipeline."}
        </p>
      </div>
    </div>
  );
}

function PipelineReportView({ pipeline }: { pipeline: PipelineResult }) {
  const { triage, patch, review } = pipeline;
  const defaultSections = [
    "root-cause",
    "evidence",
    ...(patch ? ["patch-diff"] : []),
    ...(review ? ["review-verdict"] : []),
    "patch-plan",
    "timeline",
  ];

  return (
    <div className="space-y-4 p-4 lg:p-5">
      <section className="rounded-lg border bg-background p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Badge variant="outline">gitagent</Badge>
          <Badge variant="secondary">
            {triage.failureType.replace("_", " ")}
          </Badge>
          <Badge variant={triage.status === "triaged" ? "default" : "outline"}>
            {triage.status.replace("_", " ")}
          </Badge>
          {review && (
            <Badge
              variant={
                review.verdict === "approve"
                  ? "default"
                  : review.verdict === "reject"
                    ? "destructive"
                    : "outline"
              }
              className="capitalize"
            >
              {review.verdict === "approve"
                ? "✓ Approved"
                : review.verdict === "reject"
                  ? "✗ Rejected"
                  : "⚠ Needs Changes"}
            </Badge>
          )}
        </div>
        <MarkdownText value={triage.summary} lead />
      </section>

      <Accordion multiple defaultValue={defaultSections} className="gap-3">
        <ReportSection id="root-cause" title="Root Cause">
          <MarkdownText value={triage.rootCause} />
        </ReportSection>

        {triage.reportMarkdown ? (
          <ReportSection id="report" title="Triage Report">
            <MarkdownText value={triage.reportMarkdown} />
          </ReportSection>
        ) : null}

        <ReportSection id="evidence" title="Evidence">
          <MarkdownList
            items={triage.evidence.map(
              (item) => `**${item.source}:** ${item.detail}`,
            )}
            empty="No evidence reported."
          />
        </ReportSection>

        <ReportSection id="suspected-files" title="Suspected Files">
          <MarkdownList
            items={triage.suspectedFiles}
            empty="No specific file identified."
          />
        </ReportSection>

        {patch ? (
          <ReportSection id="patch-diff" title="Proposed Patch">
            <PatchView patch={patch} />
          </ReportSection>
        ) : null}

        {review ? (
          <ReportSection id="review-verdict" title="Review Verdict">
            <ReviewView review={review} />
          </ReportSection>
        ) : null}

        <ReportSection id="patch-plan" title="Patch Plan">
          <MarkdownList
            items={triage.patchPlan}
            empty="No patch plan reported."
          />
        </ReportSection>

        <ReportSection id="safe-commands" title="Safe Commands">
          <MarkdownList items={triage.safeCommands} empty="Nothing reported." />
        </ReportSection>

        <ReportSection id="timeline" title="Agent Timeline">
          <PipelineTimeline pipeline={pipeline} />
        </ReportSection>
      </Accordion>
    </div>
  );
}

function PatchView({ patch }: { patch: PatchProposal }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant={patch.status === "patch_ready" ? "default" : "outline"}
          className="capitalize"
        >
          {patch.status.replace("_", " ")}
        </Badge>
        <Badge variant="outline" className="capitalize">
          {patch.confidence} confidence
        </Badge>
        {patch.filesModified.map((f) => (
          <Badge key={f} variant="secondary" className="font-mono text-[10px]">
            {f}
          </Badge>
        ))}
      </div>

      <MarkdownText value={patch.explanation} />

      {patch.diff && (
        <div className="rounded-md border bg-muted/30 p-0 overflow-hidden">
          <div className="border-b bg-muted/50 px-3 py-1.5 text-xs font-semibold text-muted-foreground">
            Unified Diff
          </div>
          <DiffView diff={patch.diff} />
        </div>
      )}

      {patch.caveats.length > 0 && (
        <div className="rounded-md border border-amber-500/20 bg-amber-500/5 p-3">
          <div className="mb-1.5 text-xs font-semibold uppercase text-amber-400">
            Caveats
          </div>
          <ul className="space-y-1">
            {patch.caveats.map((c, i) => (
              <li key={i} className="text-sm leading-6 text-muted-foreground">
                • {c}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function DiffView({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  return (
    <pre className="max-h-80 overflow-auto p-3 font-mono text-[12px] leading-5">
      {lines.map((line, i) => {
        let cls = "text-muted-foreground";
        if (line.startsWith("+") && !line.startsWith("+++"))
          cls = "text-emerald-400";
        if (line.startsWith("-") && !line.startsWith("---"))
          cls = "text-red-400";
        if (line.startsWith("@@")) cls = "text-blue-400";
        if (
          line.startsWith("diff") ||
          line.startsWith("---") ||
          line.startsWith("+++")
        )
          cls = "text-muted-foreground font-semibold";
        return (
          <div key={i} className={cn("min-h-[1.25rem]", cls)}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

function ReviewView({ review }: { review: ReviewVerdict }) {
  const verdictConfig = {
    approve: {
      icon: CheckCircle2Icon,
      color: "text-emerald-400",
      bg: "bg-emerald-500/10 border-emerald-500/20",
    },
    reject: {
      icon: XCircleIcon,
      color: "text-red-400",
      bg: "bg-red-500/10 border-red-500/20",
    },
    needs_changes: {
      icon: CircleAlertIcon,
      color: "text-amber-400",
      bg: "bg-amber-500/10 border-amber-500/20",
    },
  };
  const config = verdictConfig[review.verdict];
  const VerdictIcon = config.icon;

  return (
    <div className="space-y-3">
      <div
        className={cn(
          "flex items-center gap-2.5 rounded-lg border p-3",
          config.bg,
        )}
      >
        <VerdictIcon className={cn("size-5 shrink-0", config.color)} />
        <div>
          <div className={cn("text-sm font-semibold capitalize", config.color)}>
            {review.verdict.replace("_", " ")}
          </div>
          <div className="mt-0.5 text-sm text-muted-foreground">
            {review.summary}
          </div>
        </div>
      </div>

      {review.concerns.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-semibold uppercase text-muted-foreground">
            Concerns
          </div>
          {review.concerns.map((concern, i) => {
            const severityColors: Record<string, string> = {
              critical: "bg-red-500/15 text-red-400",
              high: "bg-amber-500/15 text-amber-400",
              medium: "bg-yellow-500/15 text-yellow-400",
              low: "bg-blue-500/15 text-blue-400",
            };
            return (
              <div
                key={i}
                className="flex items-start gap-2 rounded-md border bg-muted/30 p-3"
              >
                <span
                  className={cn(
                    "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase",
                    severityColors[concern.severity] ??
                      "bg-muted text-muted-foreground",
                  )}
                >
                  {concern.severity}
                </span>
                <p className="text-sm leading-6 text-foreground">
                  {concern.description}
                </p>
              </div>
            );
          })}
        </div>
      )}

      {review.recommendation && (
        <div className="rounded-md border bg-muted/30 p-3">
          <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
            Recommendation
          </div>
          <MarkdownText value={review.recommendation} />
        </div>
      )}
    </div>
  );
}

function PipelineTimeline({ pipeline }: { pipeline: PipelineResult }) {
  const sections: {
    label: string;
    items: { label: string; detail: string }[];
  }[] = [];

  sections.push({ label: "Triage Agent", items: pipeline.triage.timeline });
  if (pipeline.patch)
    sections.push({ label: "Patch Agent", items: pipeline.patch.timeline });
  if (pipeline.review)
    sections.push({ label: "Review Agent", items: pipeline.review.timeline });

  return (
    <div className="space-y-4">
      {sections.map((section) => (
        <div key={section.label}>
          <div className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
            {section.label}
          </div>
          <ol className="space-y-2">
            {section.items.map((item, index) => (
              <li
                key={`${item.label}-${index}`}
                className="rounded-md border bg-muted/30 p-3"
              >
                <div className="text-sm font-semibold">{item.label}</div>
                <div className="mt-1 break-words text-sm leading-6 text-muted-foreground">
                  {item.detail}
                </div>
              </li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}

function ReportSection({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <AccordionItem
      value={id}
      className="rounded-lg border bg-background px-4 not-last:border-b"
    >
      <AccordionTrigger className="py-3 text-xs font-semibold uppercase text-muted-foreground hover:no-underline">
        {title}
      </AccordionTrigger>
      <AccordionContent className="pb-4">{children}</AccordionContent>
    </AccordionItem>
  );
}

function MarkdownList({ items, empty }: { items: string[]; empty: string }) {
  if (!items.length)
    return <p className="text-sm leading-6 text-muted-foreground">{empty}</p>;

  return (
    <ul className="space-y-2">
      {items.map((item, index) => (
        <li
          key={`${item}-${index}`}
          className="rounded-md border bg-muted/30 p-3"
        >
          <MarkdownText value={item} />
        </li>
      ))}
    </ul>
  );
}

function MarkdownText({
  value,
  lead = false,
}: {
  value: string;
  lead?: boolean;
}) {
  return (
    <div
      className={cn(
        "min-w-0 break-words",
        lead
          ? "text-lg font-semibold leading-7 text-foreground md:text-xl md:leading-8"
          : "text-sm leading-6 text-foreground",
      )}
    >
      <ReactMarkdown components={markdownComponents}>{value}</ReactMarkdown>
    </div>
  );
}

const markdownComponents: Components = {
  h1: ({ node, ...props }) => (
    <h2
      className="mb-3 mt-1 text-xl font-semibold leading-8 text-foreground"
      {...props}
    />
  ),
  h2: ({ node, ...props }) => (
    <h3
      className="mb-2 mt-5 text-base font-semibold leading-7 text-foreground"
      {...props}
    />
  ),
  h3: ({ node, ...props }) => (
    <h4
      className="mb-2 mt-4 text-sm font-semibold leading-6 text-foreground"
      {...props}
    />
  ),
  p: ({ node, ...props }) => (
    <p className="my-2 leading-6 first:mt-0 last:mb-0" {...props} />
  ),
  strong: ({ node, ...props }) => (
    <strong className="font-semibold text-foreground" {...props} />
  ),
  a: ({ node, ...props }) => (
    <a
      className="font-medium text-foreground underline underline-offset-4"
      target="_blank"
      rel="noreferrer"
      {...props}
    />
  ),
  ul: ({ node, ...props }) => (
    <ul className="my-2 list-disc space-y-1 pl-5" {...props} />
  ),
  ol: ({ node, ...props }) => (
    <ol className="my-2 list-decimal space-y-1 pl-5" {...props} />
  ),
  li: ({ node, ...props }) => <li className="pl-1 leading-6" {...props} />,
  code: ({ node, className, ...props }) => (
    <code
      className={cn(
        "rounded-md border bg-muted px-1.5 py-0.5 font-mono text-[0.9em] text-foreground",
        className?.includes("language-") && "block border-0 bg-transparent p-0",
      )}
      {...props}
    />
  ),
  pre: ({ node, ...props }) => (
    <pre
      className="my-3 max-w-full overflow-auto rounded-md border bg-muted/50 p-3 font-mono text-xs leading-5"
      {...props}
    />
  ),
};
