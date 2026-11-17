// alchemy.run.ts
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as E2B from "@alchemy.run/e2b";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Api from "./src/Api.ts";
import { Warm } from "./src/Sandbox.ts";

export default Alchemy.Stack(
  "E2BAgentSandboxExample",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), E2B.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const warm = yield* Warm;
    const api = yield* Api;
    return { url: api.url.as<string>(), snapshot: warm.templateId };
  }),
);
