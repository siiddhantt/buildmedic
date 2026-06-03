import { listRuns } from "@/lib/runs/store";

export async function GET() {
  return Response.json({ runs: listRuns(20) });
}
