import * as Anthropic from "@alchemy.run/anthropic";
import * as Egress from "alchemy/Egress";

/** The model API: the key stays in the gateway's Worker. */
export class HarnessGateway extends Egress.Gateway<HarnessGateway>()("HarnessGateway", {
  model: Anthropic.Egress,
}) {}
