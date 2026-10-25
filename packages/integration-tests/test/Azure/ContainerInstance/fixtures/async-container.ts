import type { AsyncContainerEnv } from "./async-stack.ts";

/** A plain handler: no Effect, deployed by `async-stack.ts`. */
export default {
  async fetch(request: Request, env: AsyncContainerEnv) {
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
