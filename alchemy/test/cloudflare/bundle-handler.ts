import { initLogger } from "braintrust";
import crypto from "node:crypto";
import crypto2 from "node:crypto";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const logger = initLogger({
      projectName: "My Project",
      apiKey: env.BRAINTRUST_API_KEY,
      asyncFlush: false,
    });
    console.log(crypto.randomBytes(10));
    console.log(crypto2.randomBytes(10));
    console.log(logger);
    return new Response("Hello World!");
  },
};
