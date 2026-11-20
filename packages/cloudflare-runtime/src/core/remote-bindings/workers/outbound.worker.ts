import { DurableObject } from "cloudflare:workers";
import { decodeResponse } from "../../internal/response.shared.ts";
import type { RemoteWorkerConfig, RemoteWorkerResult } from "../RemoteWorkerConfig.shared.ts";

interface Env {
  PROXY: ColoLocalActorNamespace;
  LOOPBACK: Fetcher;
  OPTIONS: RemoteWorkerConfig;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const actor = env.PROXY.get("global");
    return await actor.fetch(request);
  },
};

/**
 * Preview tokens expire after 1 hour (hardcoded in the Workers control
 * plane). Proactively refresh at 50 minutes so no request ever pays for —
 * or worse, surfaces — an expired session. Mirrors wrangler's
 * `PREVIEW_TOKEN_REFRESH_INTERVAL` (workers-sdk #13016).
 */
const SESSION_MAX_AGE_MS = 50 * 60 * 1000;

interface Session {
  readonly config: RemoteWorkerResult;
  readonly createdAt: number;
}

/**
 * An expired/invalidated preview session surfaces in (at least) three
 * shapes:
 *
 *  - HTTP 400 with an HTML body containing "Invalid Workers Preview
 *    configuration" — the classic expired-preview-token page.
 *  - HTTP 400 with a text/plain body containing "error code: 1031" —
 *    returned by remote bindings (D1, R2, Workers AI, ...) when their
 *    underlying session has timed out.
 *  - HTTP 400 from OUR OWN uploaded remote worker: a `BindingNotFound`
 *    ConfigError means the edge routed the preview token to a deployment
 *    with a stale binding set (the edge preview dedupes deployments by
 *    script content and can serve an older deployment's env). A fresh
 *    deploy re-uploads with the current bindings.
 *
 * All mean the cached session must be discarded and recreated. The first
 * two matchers mirror wrangler's `checkForPreviewTokenError`.
 */
async function isStaleSessionResponse(response: Response): Promise<boolean> {
  if (response.status !== 400) {
    return false;
  }
  const text = await response.clone().text();
  return (
    text.includes("Invalid Workers Preview configuration") ||
    text.includes("error code: 1031") ||
    (text.includes('"BindingNotFound"') && text.includes('"ConfigError"'))
  );
}

/**
 * Set by the remote worker on every response it forwards from a binding.
 * Responses generated in front of it (a Cloudflare Access login redirect or
 * block page) never carry it. Ported from workers-sdk #16306.
 */
const FORWARDED_RESPONSE_HEADER = "MF-Forwarded-Response";

/**
 * How Cloudflare Access stopped a request to the remote worker: a 403 block
 * page, or a redirect to the Access login page (no valid credentials, e.g. an
 * expired `CF_Authorization` cookie).
 */
type AccessBlockReason = "blocked" | "login-redirect";

function stripForwardedResponseMarker(response: Response): Response {
  // A WebSocket upgrade response can't be re-wrapped without losing its socket.
  if (response.webSocket) {
    return response;
  }
  const stripped = new Response(response.body, response);
  stripped.headers.delete(FORWARDED_RESPONSE_HEADER);
  return stripped;
}

/** `https://<team>.cloudflareaccess.com/cdn-cgi/access/login/<host>?...` */
function isCloudflareAccessLoginUrl(location: string | null): boolean {
  if (location === null) {
    return false;
  }
  try {
    const { hostname, pathname } = new URL(location);
    return (
      hostname.endsWith(".cloudflareaccess.com") && pathname.startsWith("/cdn-cgi/access/login")
    );
  } catch {
    return false;
  }
}

async function getCloudflareAccessBlockReason(
  response: Response,
): Promise<AccessBlockReason | undefined> {
  if (response.status >= 300 && response.status < 400) {
    return isCloudflareAccessLoginUrl(response.headers.get("Location"))
      ? "login-redirect"
      : undefined;
  }
  if (response.status !== 403) {
    return undefined;
  }
  let text: string;
  try {
    text = await response.clone().text();
  } catch {
    return undefined;
  }
  // Access block pages contain "Cloudflare Access" (title: "Error ・ Cloudflare Access").
  return text.includes("Cloudflare Access") ? "blocked" : undefined;
}

function buildAccessBlockResponseBody(
  bindingName: string,
  proxyUrl: string,
  reason: AccessBlockReason,
): string {
  const credentials = [
    `Set the CLOUDFLARE_ACCESS_CLIENT_ID and CLOUDFLARE_ACCESS_CLIENT_SECRET`,
    `environment variables (Service Token credentials), or restart the dev`,
    `session to sign in to Access again with \`cloudflared access login\`.`,
    ``,
    `See https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/`,
  ];
  if (reason === "login-redirect") {
    return [
      `Cloudflare Access redirected this remote bindings request to its login page (binding "${bindingName}").`,
      ``,
      `The request to ${proxyUrl} did not carry valid Access credentials.`,
      ``,
      ...credentials,
    ].join("\n");
  }
  return [
    `Cloudflare Access blocked this remote bindings request (binding "${bindingName}").`,
    ``,
    `The request to ${proxyUrl} was rejected by an Access policy.`,
    ``,
    ...credentials,
  ].join("\n");
}

export class RemoteBindingProxy extends DurableObject<Env> {
  private session: Session | undefined;

  async fetch(request: Request): Promise<Response> {
    const session = await this.configure();
    // The first attempt consumes the request body; keep a clone so a
    // stale-session retry can replay it.
    const retry = request.body ? request.clone() : request;
    const response = await this.proxy(request, session);
    if (await isStaleSessionResponse(response)) {
      const fresh = await this.configure(session);
      return await this.checkAccess(await this.proxy(retry, fresh), request, fresh);
    }
    return await this.checkAccess(response, request, session);
  }

  private warnedAccessBlock = false;

  /**
   * Responses the remote worker forwards from a binding carry
   * {@link FORWARDED_RESPONSE_HEADER}, which is stripped here. An unmarked
   * Access block or login redirect came from Cloudflare Access in front of
   * the remote worker: replace it with readable guidance, because a login
   * redirect passed back to the binding would be followed through the same
   * proxy and redirect again until workerd fails with "Too many redirects".
   */
  private async checkAccess(
    response: Response,
    request: Request,
    session: Session,
  ): Promise<Response> {
    if (response.headers.has(FORWARDED_RESPONSE_HEADER)) {
      return stripForwardedResponseMarker(response);
    }
    const reason = await getCloudflareAccessBlockReason(response);
    if (reason === undefined) {
      return response;
    }
    const bindingName =
      request.headers.get("MF-Binding") ??
      new URL(request.url).searchParams.get("MF-Binding") ??
      "<unknown>";
    const body = buildAccessBlockResponseBody(bindingName, session.config.url, reason);
    if (!this.warnedAccessBlock) {
      this.warnedAccessBlock = true;
      console.warn(body);
    }
    // Headers are not copied: they may carry Access cookies and the login
    // `Location`. Any redirect status would just be followed again.
    return new Response(body, {
      ...(reason === "login-redirect"
        ? { status: 401 }
        : { status: response.status, statusText: response.statusText }),
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  /**
   * Return the cached preview session, deploying a fresh one when there is
   * none, the cached one is older than {@link SESSION_MAX_AGE_MS}, or the
   * caller observed the cached session (`stale`) fail. Passing the failed
   * session makes recovery single-flight: concurrent requests that all hit
   * the same expired session share one redeploy instead of each minting a
   * new preview session.
   */
  private configure(stale?: Session): Promise<Session> {
    const cached = this.session;
    if (cached && this.isUsable(cached, stale)) {
      return Promise.resolve(cached);
    }
    return this.ctx.blockConcurrencyWhile(async () => {
      // Re-check under the lock: a concurrent request may have already
      // refreshed the session while we were waiting.
      const current = this.session;
      if (current && this.isUsable(current, stale)) {
        return current;
      }
      this.session = undefined;
      const response = await this.env.LOOPBACK.fetch("http://stub", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(this.env.OPTIONS),
      });
      const config = await decodeResponse<RemoteWorkerResult>(response);
      const session: Session = { config, createdAt: Date.now() };
      this.session = session;
      return session;
    });
  }

  private isUsable(session: Session, stale: Session | undefined): boolean {
    return session !== stale && Date.now() - session.createdAt < SESSION_MAX_AGE_MS;
  }

  private async proxy(request: Request, session: Session): Promise<Response> {
    const origin = new URL(request.url);
    const target = new URL(origin.pathname + origin.search, session.config.url);
    const proxiedHeaders = new Headers(request.headers);
    for (const [key, value] of Object.entries(session.config.headers)) {
      proxiedHeaders.set(key, value);
    }
    // Redirects go back to the binding, which follows them itself; following
    // one here would hand an Access login page back as a binding response.
    return await fetch(
      target,
      new Request(request, { headers: proxiedHeaders, redirect: "manual" }),
    );
  }
}
