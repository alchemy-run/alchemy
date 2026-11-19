import { WorkerEntrypoint } from "cloudflare:workers";

type Env = {
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
  GREETING: string;
  /** This Worker's own `Greeter` entrypoint, when the test binds it. */
  SELF_GREETER?: { greet(name: string): Promise<string> };
};

/** A named entrypoint the Worker can bind to itself. */
export class Greeter extends WorkerEntrypoint {
  greet(name: string): string {
    return `hello ${name} from Greeter`;
  }
}

/**
 * The custom Worker entry a Foldkit deployment can carry alongside its
 * client build: it answers an API route from a binding and hands every
 * other request to the assets binding, where `notFoundHandling` still
 * applies — so deep links keep falling back to `index.html` and the
 * Foldkit router boots.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/hello") {
      return Response.json({ greeting: env.GREETING });
    }

    if (url.pathname === "/api/self" && env.SELF_GREETER) {
      return Response.json({ greeting: await env.SELF_GREETER.greet("self") });
    }

    return env.ASSETS.fetch(request);
  },
};
