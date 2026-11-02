import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { testName } from "../../../names.ts";

/** A store only this entrypoint describes: `--backend` can't address it. */
export const workerName = testName("alchemy-state-store-configured");

export default Alchemy.Stack(
  "ConfiguredStateStore",
  { providers: Cloudflare.providers(), state: Cloudflare.state({ workerName }) },
  Effect.gen(function* () {
    return {};
  }),
);
