import * as Cloudflare from "@alchemy.run/cloudflare";
import { defaultStage } from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

/** A store only this entrypoint describes: `--backend` can't address it. */
export const workerName = `alchemy-state-store-configured-${defaultStage().replaceAll("_", "-")}`;

export default Alchemy.Stack(
  "ConfiguredStateStore",
  { providers: Cloudflare.providers(), state: Cloudflare.state({ workerName }) },
  Effect.gen(function* () {
    return {};
  }),
);
