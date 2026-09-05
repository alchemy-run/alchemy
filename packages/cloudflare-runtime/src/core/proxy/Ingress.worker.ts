import { DurableObject } from "cloudflare:workers";
import * as Schema from "effect/Schema";

/**
 * The dev ingress: one HTTP front door for every locally served resource,
 * routed by the request's `Host` header (`api.localhost`, `web.localhost`,
 * `api.myapp.test`, …). Each host maps to an upstream URL — typically a
 * worker's stable `WorkerProxy` — and the ingress forwards the request
 * verbatim (method, path, query, body, WebSocket upgrades), stamping
 * `X-Forwarded-Host` / `X-Forwarded-Proto` with the public host unless a
 * hop in front of us (a reverse proxy) already did.
 *
 * Routes are mutated through an authenticated controller API under
 * `/cdn-cgi/ingress/…`; `/cdn-cgi/ingress/health` is public and carries the
 * instance id so a caller can detect that a privileged port (`:80`) is
 * forwarding to THIS ingress.
 */
interface Env {
  INGRESS: ColoLocalActorNamespace;
  INGRESS_TOKEN: string;
  /** Public, non-secret identity of this ingress instance (health probes). */
  INGRESS_ID: string;
  /** The dev domain every route's host ends with (`localhost`, `myapp.test`). */
  INGRESS_DOMAIN: string;
}

export interface IngressRoute {
  /** Upstream URL requests for this host are forwarded to. */
  readonly upstream: string;
  /** Human label shown on the index page (the resource's logical id). */
  readonly label?: string;
  /** Fully-qualified resource name. */
  readonly fqn?: string;
  /** Resource type (`Cloudflare.Worker`, `Command.Dev`, …). */
  readonly type?: string;
}

const CONTROLLER_PREFIX = "/cdn-cgi/ingress/";

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return env.INGRESS.get("global").fetch(request);
  },
};

export class Ingress extends DurableObject<Env> {
  routes = new Map<string, IngressRoute>();

  async fetch(request: Request) {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith(CONTROLLER_PREFIX)) {
        return await this.handleController(request, url);
      }
      return await this.handleRouted(request, url);
    } catch (error) {
      return IngressError.from(error).toResponse();
    }
  }

  private async handleController(
    request: Request,
    url: URL,
  ): Promise<Response> {
    const action = url.pathname.slice(CONTROLLER_PREFIX.length);
    if (action === "health") {
      return Response.json({
        ok: true,
        id: this.env.INGRESS_ID,
        domain: this.env.INGRESS_DOMAIN,
      });
    }
    this.authorize(request);
    if (action === "routes") {
      if (request.method !== "GET") {
        throw new IngressError({
          message: "Method not allowed",
          hint: `Expected GET but got ${request.method}.`,
          status: 405,
        });
      }
      return Response.json(Object.fromEntries(this.routes));
    }
    if (action.startsWith("routes/")) {
      const host = normalizeHost(
        decodeURIComponent(action.slice("routes/".length)),
      );
      if (host === "") {
        throw new IngressError({
          message: "Invalid route",
          hint: "The route host is empty.",
          status: 400,
        });
      }
      switch (request.method) {
        case "PUT": {
          const route = await readRoute(request);
          this.routes.set(host, route);
          return new Response(null, { status: 204 });
        }
        case "DELETE": {
          this.routes.delete(host);
          return new Response(null, { status: 204 });
        }
        default: {
          throw new IngressError({
            message: "Method not allowed",
            hint: `Expected PUT or DELETE but got ${request.method}.`,
            status: 405,
          });
        }
      }
    }
    throw new IngressError({
      message: "Unknown ingress controller action",
      status: 404,
    });
  }

  private authorize(request: Request): void {
    const token = request.headers.get("authorization")?.split(" ")[1];
    if (!token || !isTimingSafeEqual(token, this.env.INGRESS_TOKEN)) {
      throw new IngressError({
        message: "Ingress authorization failed",
        hint: "The secret is incorrect.",
        status: 401,
      });
    }
  }

  private async handleRouted(request: Request, url: URL): Promise<Response> {
    const host = normalizeHost(request.headers.get("host") ?? url.host);
    const route = this.routes.get(host);
    if (route) {
      return await this.forward(request, url, route);
    }
    if (isBareHost(host, this.env.INGRESS_DOMAIN)) {
      // A single-resource project keeps working at the bare address
      // (`http://localhost:1337`); with several resources the bare address
      // is a directory of them.
      if (this.routes.size === 1) {
        const [only] = this.routes.values();
        return await this.forward(request, url, only!);
      }
      return this.renderIndex(request, url);
    }
    return this.renderNotFound(request, url, host);
  }

  private async forward(
    request: Request,
    original: URL,
    route: IngressRoute,
  ): Promise<Response> {
    const proxied = new URL(route.upstream);
    proxied.pathname = original.pathname;
    proxied.search = original.search;
    const headers = new Headers(request.headers);
    // Preserve what a hop in front of us said (a proxy reports the public
    // hostname) — otherwise the public host is the one the client dialed.
    if (!headers.has("x-forwarded-host")) {
      headers.set(
        "x-forwarded-host",
        request.headers.get("host") ?? original.host,
      );
    }
    if (!headers.has("x-forwarded-proto")) {
      headers.set("x-forwarded-proto", original.protocol.replace(/:$/, ""));
    }
    try {
      return await fetch(proxied, {
        method: request.method,
        headers,
        body: request.body,
        redirect: "manual",
      });
    } catch (error) {
      throw new IngressError({
        message: `Failed to reach the upstream for ${normalizeHost(
          request.headers.get("host") ?? original.host,
        )} (${route.upstream})`,
        hint: "The resource may still be starting, or it crashed — check the alchemy dev output.",
        status: 502,
        cause: error,
      });
    }
  }

  private renderIndex(request: Request, url: URL): Response {
    const routes = [...this.routes.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    );
    if (wantsJson(request)) {
      return Response.json({
        domain: this.env.INGRESS_DOMAIN,
        routes: Object.fromEntries(routes),
      });
    }
    const port = url.port;
    const items = routes
      .map(([host, route]) => {
        const href = `${url.protocol}//${host}${port ? `:${port}` : ""}`;
        return `<li>
  <div class="name">${escapeHtml(route.label ?? host)}<span class="type">${escapeHtml(
    route.type ?? "",
  )}</span></div>
  <a href="${escapeHtml(href)}">${escapeHtml(href)}</a>
  <div class="upstream">→ ${escapeHtml(route.upstream)}</div>
</li>`;
      })
      .join("\n");
    return new Response(
      renderPage(
        "alchemy dev",
        routes.length === 0
          ? `<p class="muted">No resources are exposed yet.</p>`
          : `<ul class="routes">${items}</ul>`,
      ),
      { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }

  private renderNotFound(request: Request, url: URL, host: string): Response {
    const known = [...this.routes.keys()].sort();
    if (wantsJson(request)) {
      return Response.json(
        {
          ok: false,
          error: {
            _tag: "IngressError",
            message: `No local resource is exposed at ${host}`,
            hosts: known,
          },
        },
        { status: 404 },
      );
    }
    const port = url.port;
    const list = known
      .map((h) => {
        const href = `${url.protocol}//${h}${port ? `:${port}` : ""}`;
        return `<li><a href="${escapeHtml(href)}">${escapeHtml(href)}</a></li>`;
      })
      .join("\n");
    return new Response(
      renderPage(
        `Unknown host: ${escapeHtml(host)}`,
        `<p>No local resource is exposed at <code>${escapeHtml(host)}</code>.</p>
${known.length > 0 ? `<p class="muted">Known hosts:</p><ul class="hosts">${list}</ul>` : `<p class="muted">Nothing is exposed yet.</p>`}`,
      ),
      { status: 404, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }
}

/** Lower-case hostname without the port. */
const normalizeHost = (host: string): string => {
  const trimmed = host.trim().toLowerCase();
  // `[::1]:1337` → `[::1]`; `api.localhost:1337` → `api.localhost`.
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end === -1 ? trimmed : trimmed.slice(0, end + 1);
  }
  const colon = trimmed.indexOf(":");
  return colon === -1 ? trimmed : trimmed.slice(0, colon);
};

const isBareHost = (host: string, domain: string): boolean =>
  host === domain ||
  host === "localhost" ||
  host === "127.0.0.1" ||
  host === "[::1]" ||
  host === "0.0.0.0" ||
  /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ||
  host.startsWith("[");

const wantsJson = (request: Request): boolean => {
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("application/json") && !accept.includes("text/html");
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const renderPage = (title: string, body: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 3rem 1.5rem; font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; background: #f6f6f7; color: #1c1c1e; }
  main { max-width: 42rem; margin: 0 auto; }
  h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 1.25rem; }
  h1 small { font-weight: 400; color: #6b6b70; margin-left: .5rem; }
  ul { list-style: none; padding: 0; margin: 0; }
  .routes li { background: #fff; border: 1px solid #e3e3e6; border-radius: 8px; padding: .9rem 1.1rem; margin-bottom: .75rem; }
  .name { font-weight: 600; margin-bottom: .15rem; }
  .type { font-weight: 400; color: #6b6b70; font-size: .8rem; margin-left: .5rem; }
  a { color: #1a5fd6; text-decoration: none; word-break: break-all; }
  a:hover { text-decoration: underline; }
  .upstream, .muted { color: #6b6b70; font-size: .85rem; }
  code { font: .9em ui-monospace, SFMono-Regular, Menlo, monospace; }
  .hosts li { margin: .25rem 0; }
  @media (prefers-color-scheme: dark) {
    body { background: #111113; color: #ececef; }
    .routes li { background: #1b1b1f; border-color: #2b2b31; }
    a { color: #7aa7ff; }
    .type, .upstream, .muted { color: #8c8c93; }
  }
</style>
</head>
<body>
<main>
<h1>${title}<small>alchemy dev</small></h1>
${body}
</main>
</body>
</html>
`;

class IngressError extends Schema.TaggedError<IngressError>()("IngressError", {
  message: Schema.String,
  hint: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Defect({ includeStack: true })),
}) {
  static from = (error: unknown) =>
    error instanceof IngressError
      ? error
      : new IngressError({
          message: "An unknown error occurred",
          cause: error,
        });

  static encode = Schema.encodeSync(IngressError);

  toResponse(): Response {
    return Response.json(
      { ok: false, error: IngressError.encode(this) },
      { status: this.status ?? 500 },
    );
  }
}

const isTimingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) {
    return false;
  }
  const encoder = new TextEncoder();
  return crypto.subtle.timingSafeEqual(encoder.encode(a), encoder.encode(b));
};

const readRoute = async (request: Request): Promise<IngressRoute> => {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch (error) {
    throw new IngressError({
      message: "Invalid route",
      hint: "The route body is not JSON.",
      status: 400,
      cause: error,
    });
  }
  if (
    typeof raw !== "object" ||
    raw === null ||
    typeof (raw as { upstream?: unknown }).upstream !== "string"
  ) {
    throw new IngressError({
      message: "Invalid route",
      hint: "The route body must be `{ upstream: string, … }`.",
      status: 400,
    });
  }
  const route = raw as IngressRoute;
  try {
    new URL(route.upstream);
  } catch (error) {
    throw new IngressError({
      message: "Invalid route",
      hint: "The upstream is not a valid URL.",
      status: 400,
      cause: error,
    });
  }
  return route;
};
