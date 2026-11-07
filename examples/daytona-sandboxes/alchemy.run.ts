// alchemy.run.ts
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Daytona from "@alchemy.run/daytona";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Api from "./src/Api.ts";
import { Base } from "./src/Images.ts";

export default Alchemy.Stack(
  "DaytonaSandboxes",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Daytona.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const base = yield* Base;
    const api = yield* Api;
    return { url: api.url.as<string>(), snapshot: base.name };
  }),
);
