/**
 * Local-dev async fixture: legacy Node `(req, res)` default export (arm 2
 * of the launcher matrix — detected by the handler's 2-parameter arity).
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export default function handler(
  req: IncomingMessage,
  res: ServerResponse,
): void {
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ node: true, url: req.url ?? null }));
}
