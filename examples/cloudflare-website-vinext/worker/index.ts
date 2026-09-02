import handler from "vinext/server/fetch-handler";
import type { VinextEnv } from "../alchemy.run.ts";

export default {
  async fetch(request, env, ctx) {
    return handler.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<VinextEnv>;
