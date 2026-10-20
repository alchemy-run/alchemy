import * as Anthropic from "@alchemy.run/anthropic";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { HarnessGateway } from "./gateway.ts";

export default class HarnessGatewayWorker extends Cloudflare.Worker<HarnessGatewayWorker>()(
  "HarnessGatewayWorker",
  { main: import.meta.url },
  HarnessGateway.serve(
    Effect.gen(function* () {
      return {
        model: yield* Anthropic.Egress({ apiKey: Config.Redacted("ANTHROPIC_API_KEY") }),
      };
    }),
  ),
) {}
