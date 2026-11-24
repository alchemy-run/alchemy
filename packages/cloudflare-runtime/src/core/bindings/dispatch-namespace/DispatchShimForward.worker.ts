/**
 * Dev-mode forwarder for a dispatch binding with an outbound Worker.
 *
 * Cloudflare's preview refuses a dispatch binding that has an outbound
 * Worker, so the binding targets a REAL deployed shim Worker that holds it
 * (see `WorkersForPlatforms/internal/DispatchShim.ts` in
 * `@alchemy.run/cloudflare`). This service is the local half: it forwards the
 * dispatch extension's request, with its `MF-Dispatch-Namespace-Options`
 * header, to the shim over HTTPS, authenticated with the shim's token in a
 * header of its own (the request's `Authorization` reaches the user Worker), and
 * passes the original URL along.
 */
interface Env {
  SHIM_URL: string;
  SHIM_TOKEN: string;
}

/** The shim marks every answer, so a user Worker's own 404 is never retried. */
const SHIM_HEADER = "x-alchemy-dispatch-shim";
/** A dispatch that failed: the binding rejects, as it does on Cloudflare. */
const ERROR_HEADER = "x-alchemy-dispatch-error";
const URL_HEADER = "x-alchemy-dispatch-url";
const TOKEN_HEADER = "x-alchemy-dispatch-token";
const MAX_ATTEMPTS = 6;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const target = new URL(url.pathname + url.search, env.SHIM_URL);
    const headers = new Headers(request.headers);
    headers.set(TOKEN_HEADER, env.SHIM_TOKEN);
    headers.set(URL_HEADER, request.url);
    // The body may be replayed on retry: buffer it up front.
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer();
    let last = "";
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      }
      // A fetch that throws fails the dispatch: only the unmarked answer
      // below was measured as transient.
      const response = await fetch(target, {
        method: request.method,
        headers,
        body,
        redirect: "manual",
      });
      // An answer without the mark is the shim's workers.dev URL before it
      // serves (404/503 and 52x for a few seconds after it deploys).
      if (response.headers.has(SHIM_HEADER)) {
        const answer = new Response(response.body, response);
        answer.headers.delete(SHIM_HEADER);
        return answer;
      }
      last = `answered ${response.status} without the shim's mark`;
      await response.body?.cancel();
    }
    // Never the unmarked page: it isn't the user Worker's answer.
    return new Response(
      `The dispatch shim at ${env.SHIM_URL} didn't answer after ${MAX_ATTEMPTS} attempts (last ${last}).`,
      { status: 502, headers: { [ERROR_HEADER]: "1" } },
    );
  },
} satisfies ExportedHandler<Env>;
