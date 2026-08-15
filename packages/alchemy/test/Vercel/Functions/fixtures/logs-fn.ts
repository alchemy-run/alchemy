/**
 * Fixture for the logs/tail wiring test: logs a recognizable marker line on
 * every request so the runtime-logs stream has something deterministic to
 * capture.
 */
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    console.log(`alchemy-logs-probe ${url.pathname}`);
    return Response.json({ ok: true, path: url.pathname });
  },
};
