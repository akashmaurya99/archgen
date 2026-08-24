import type { IncomingMessage, ServerResponse } from "node:http";

const routes: Record<string, string> = {
  "GET /health": "ok",
  "GET /notes": "seeded notes list",
};

export function handleRoute(req: IncomingMessage, res: ServerResponse): void {
  const key = `${req.method} ${req.url}`;
  const known = routes[key] !== undefined;
  res.statusCode = known ? 200 : 404;
  res.end(known ? routes[key] : "not found");
}
