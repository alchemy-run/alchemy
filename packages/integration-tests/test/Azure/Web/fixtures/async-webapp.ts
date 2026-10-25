import type { AsyncWebAppEnv } from "./async-webapp-stack.ts";

/** A plain handler: no Effect, deployed by `async-webapp-stack.ts`. */
export default {
  async fetch(request: Request, env: AsyncWebAppEnv) {
    const url = new URL(request.url);
    const name = url.searchParams.get("name") ?? "world";
    return Response.json({
      message: `${env.GREETING} ${name}`,
      secretLength: env.SECRET.length,
      container: env.CONTAINER.containerName,
      method: request.method,
      path: url.pathname,
      body: request.method === "POST" ? await request.text() : undefined,
      node: process.versions.node,
    });
  },
};
