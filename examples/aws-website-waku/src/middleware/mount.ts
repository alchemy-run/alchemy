/**
 * The mount file — YOURS (waku's framework hook: a middleware module in
 * `src/middleware/`, run by waku's handler pipeline in dev AND prod). You
 * own HTTP composition: dispatch order, gates, and custom routes are
 * ordinary code around `site.fetch`, and waku serves whatever you fall
 * through to. On AWS the platform handlers (queue consumer) ride the
 * generated single-handler Lambda entry around waku's handler — derived
 * from the backend program's `yield*` registrations, never written here.
 *
 * `site.fetch(request)` takes no env/ctx on AWS: env resolves from
 * `process.env` (the Lambda sandbox env, or the dev-server process env
 * `alchemy dev` lowered the same values into), and the request scope
 * settles inline before the response — Lambda semantics.
 */
import { mount } from "alchemy/Serve";
import type { Context, Next } from "hono";
import Site from "../backend.ts";

const site = mount(Site);

export default () =>
  async (c: Context, next: Next): Promise<Response | undefined> => {
    const request = c.req.raw;
    const url = new URL(request.url);

    // Answered in the mount itself — no framework, no effect runtime.
    if (url.pathname === "/healthz") {
      return new Response("ok", { status: 200 });
    }

    // A gate ahead of BOTH worlds: /api/admin/* requires a header.
    if (
      url.pathname.startsWith("/api/admin") &&
      request.headers.get("x-admin-key") !== "letmein"
    ) {
      return new Response("forbidden", { status: 403 });
    }

    const response = await site.fetch(request);
    if (response !== undefined) {
      return response;
    }
    await next();
    return undefined;
  };
