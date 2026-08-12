/**
 * Front-door worker for the single-origin deployment: the SPA, the REST
 * API, and the git wire protocol all live on ONE host (e.g.
 * git.alchemy.run). API and wire requests are forwarded to the GitWorker
 * over a private service binding; everything else is served from the Vite
 * static assets.
 *
 * One origin matters beyond aesthetics: clone URLs shown in the UI are
 * same-host (no `workers.dev`, which some ad-block/malware lists block),
 * and the SPA needs no CORS.
 */

interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

interface Env {
  /** Service binding to the GitWorker (REST + wire planes). */
  GIT: Fetcher;
  /** The Vite-built static assets. */
  ASSETS: Fetcher;
}

/** `/api/v1/**` — the typed REST management plane. */
const API_PREFIX = /^\/api\/v1\//;

/**
 * The git smart-HTTP wire endpoints: `/:owner/:repo[.git]/info/refs`,
 * `git-upload-pack`, `git-receive-pack`.
 */
const WIRE_PATH =
  /^\/[^/]+\/[^/]+\/(?:info\/refs$|git-upload-pack$|git-receive-pack$)/;

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (API_PREFIX.test(pathname) || WIRE_PATH.test(pathname)) {
      // Forwarded verbatim: the Host header stays this origin, so the
      // GitWorker derives same-host clone/remote URLs, and push bodies
      // stream through the binding untouched.
      return env.GIT.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
