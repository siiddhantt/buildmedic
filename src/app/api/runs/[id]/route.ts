import { deleteRun, getRun } from "@/lib/runs/store";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const run = getRun(id);

  if (!run) {
    return Response.json({ error: "Run not found." }, { status: 404 });
  }

  return Response.json({ run });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const deleted = deleteRun(id);

  if (!deleted) {
    return Response.json({ error: "Run not found." }, { status: 404 });
  }

  return Response.json({ deleted: true });
}
