import * as Archil from "@alchemy.run/archil";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Api from "./src/Api.ts";
import { Seeded } from "./src/Workspace.ts";

export default Alchemy.Stack(
  "ArchilWorkspaces",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Archil.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    yield* Seeded;
    const api = yield* Api;
    return { url: api.url.as<string>() };
  }),
);
