import { runPipeline, type PipelineEvent } from "@/lib/pipeline";
import { parsePullRequestUrl } from "@/lib/pr-url";
import {
  completeRun,
  createRun,
  failRun,
  recordPipelineEvent,
} from "@/lib/runs/store";
import { TriageRequestSchema } from "@/lib/types";

const encoder = new TextEncoder();

export async function POST(request: Request) {
  const stream = new ReadableStream({
    async start(controller) {
      let runId: string | null = null;

      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      try {
        const body = await request.json();
        const input = TriageRequestSchema.parse(body);
        const ref = parsePullRequestUrl(input.prUrl);
        runId = createRun(input.prUrl, ref);
        const activeRunId = runId;
        send("run", { runId: activeRunId });
        send("status", {
          message: "Accepted PR URL. Starting multi-agent pipeline.",
          runId: activeRunId,
        });

        const result = await runPipeline(input.prUrl, ref, {
          onEvent(event: PipelineEvent) {
            recordPipelineEvent(activeRunId, event);
            if (event.type === "stage") {
              send("stage", event);
            } else {
              send(event.type, event);
            }
          },
        });

        completeRun(activeRunId, result);
        send("final", { runId: activeRunId, result });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unable to run pipeline.";
        if (runId) failRun(runId, error);
        send("error", { message, runId });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
    },
  });
}
