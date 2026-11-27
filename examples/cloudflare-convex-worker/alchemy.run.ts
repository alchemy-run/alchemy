// alchemy.run.ts
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Convex from "@alchemy.run/convex";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Api from "./src/Api.ts";
import { Backend } from "./src/Backend.ts";

export default Alchemy.Stack(
  "CloudflareConvexWorkerExample",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Convex.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const deployment = yield* Backend;
    yield* Convex.Functions("Functions", { deployment, rootDir: "." });
    const api = yield* Api;
    return { url: api.url.as<string>() };
  }),
);
