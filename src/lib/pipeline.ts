import { runGitAgentTriage, type AgentEvent } from "./gitagent";
import { runPatchAgent, type PatchEvent } from "./patch-agent";
import { runReviewAgent, type ReviewEvent } from "./review-agent";
import type { PullRequestRef } from "./pr-url";
import type { PipelineResult, TriageReport } from "./types";

export type PipelineStage =
  | "triage"
  | "patching"
  | "reviewing"
  | "complete"
  | "failed";

export type PipelineEvent =
  | {
      type: "stage";
      stage: PipelineStage;
      status: "running" | "complete" | "skipped" | "failed";
    }
  | ((AgentEvent | PatchEvent | ReviewEvent) & {
      agent: "triage" | "patch" | "review";
    });

type PipelineOptions = {
  onEvent?: (event: PipelineEvent) => void;
};

export async function runPipeline(
  prUrl: string,
  ref: PullRequestRef,
  options: PipelineOptions = {},
): Promise<PipelineResult> {
  const emit = options.onEvent ?? (() => undefined);

  emit({ type: "stage", stage: "triage", status: "running" });
  let triage: TriageReport | null;
  try {
    triage = await runGitAgentTriage(prUrl, ref, {
      onEvent(event) {
        if (event.type === "final") return;
        emit({ ...event, agent: "triage" } as PipelineEvent);
      },
    });
  } catch (err) {
    emit({ type: "stage", stage: "triage", status: "failed" });
    throw err;
  }

  if (!triage) {
    emit({ type: "stage", stage: "triage", status: "failed" });
    throw new Error("Triage agent did not produce a report.");
  }

  emit({ type: "stage", stage: "triage", status: "complete" });

  if (triage.status === "needs_more_context") {
    emit({ type: "stage", stage: "patching", status: "skipped" });
    emit({ type: "stage", stage: "reviewing", status: "skipped" });
    emit({ type: "stage", stage: "complete", status: "complete" });
    return { triage, pipelineStage: "complete" };
  }

  emit({ type: "stage", stage: "patching", status: "running" });
  let patch;
  try {
    patch = await runPatchAgent(triage, ref, {
      onEvent(event) {
        emit({ ...event, agent: "patch" } as PipelineEvent);
      },
    });
  } catch {
    emit({ type: "stage", stage: "patching", status: "failed" });
    emit({ type: "stage", stage: "reviewing", status: "skipped" });
    emit({ type: "stage", stage: "complete", status: "complete" });
    return { triage, pipelineStage: "complete" };
  }

  emit({
    type: "stage",
    stage: "patching",
    status: patch ? "complete" : "failed",
  });

  if (!patch) {
    emit({ type: "stage", stage: "reviewing", status: "skipped" });
    emit({ type: "stage", stage: "complete", status: "complete" });
    return { triage, pipelineStage: "complete" };
  }

  emit({ type: "stage", stage: "reviewing", status: "running" });
  let review;
  try {
    review = await runReviewAgent(triage, patch, ref, {
      onEvent(event) {
        emit({ ...event, agent: "review" } as PipelineEvent);
      },
    });
  } catch {
    emit({ type: "stage", stage: "reviewing", status: "failed" });
  }

  emit({
    type: "stage",
    stage: "reviewing",
    status: review ? "complete" : "failed",
  });
  emit({ type: "stage", stage: "complete", status: "complete" });

  return {
    triage,
    patch,
    review: review ?? undefined,
    pipelineStage: "complete",
  };
}
