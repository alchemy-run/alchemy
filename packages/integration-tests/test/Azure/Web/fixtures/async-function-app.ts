import type { AsyncFunctionAppEnv } from "./async-function-app-stack.ts";

/** A plain handler: no Effect, deployed by `async-function-app-stack.ts`. */
export default {
  async fetch(request: Request, env: AsyncFunctionAppEnv) {
    const url = new URL(request.url);
    const name = url.searchParams.get("name") ?? "world";
    return Response.json({
      message: `${env.GREETING} ${name}`,
      secretLength: env.SECRET.length,
      container: env.CONTAINER.containerName,
      path: url.pathname,
      node: process.versions.node,
    });
  },
};
