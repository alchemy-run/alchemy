import type { HelloEnv } from "../alchemy.run.ts";

/** An async program: a plain fetch handler, bundled with no Effect runtime. */
export default {
  async fetch(request: Request, env: HelloEnv) {
    return new Response(`${env.GREETING} from ${new URL(request.url).pathname}`);
  },
};
