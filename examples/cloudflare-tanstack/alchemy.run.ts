import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import Backend, { Bucket } from "./src/backend.ts";

export const Website = Cloudflare.Vite("Websiter", {
  compatibility: {
    flags: ["nodejs_compat"],
  },
  bindings: {
    BUCKET: Bucket,
    BACKEND: Backend,
  },
});

export type WebsiteEnv = Cloudflare.InferEnv<typeof Website>;

export default Alchemy.Stack(
  "CloudflareTanstackExample",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const website = yield* Website;
    return {
      url: website.url.as<string>(),
    };
  }),
);
