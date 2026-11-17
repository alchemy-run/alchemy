// alchemy.run.ts
import * as Boat from "@alchemy.run/boat";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Api from "./src/Api.ts";
import { Golden } from "./src/Golden.ts";

export default Alchemy.Stack(
  "BoatAgentSandboxExample",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Boat.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const golden = yield* Golden;
    const api = yield* Api;
    return { snapshot: golden.name, url: api.url.as<string>() };
  }),
);
