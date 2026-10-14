import * as Anthropic from "@/Anthropic/index.ts";
import * as Egress from "@/Egress/index.ts";

/** The model API: the key stays in the gateway's Worker. */
export class HarnessGateway extends Egress.Gateway<HarnessGateway>()("HarnessGateway", {
  model: Anthropic.Egress,
}) {}
