import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { api } from "./api";

// TODO: looks like openauth imports node:fs ...
// import { issuer } from "./auth/issuer";

const app = new Hono();
// app.route("/auth", issuer);
app.route("/api/", api);

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) {
      return app.fetch(request);
    }
    // @ts-ignore
    return env.ASSETS.fetch(request);
  },
};
