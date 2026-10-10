export const runtime = "nodejs";

// Liveness for container probes. Deliberately unauthenticated and reveals nothing.
export function GET() {
  return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
}
