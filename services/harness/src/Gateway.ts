import * as Anthropic from "@alchemy.run/anthropic";
import * as GitHub from "@alchemy.run/github";
import * as Egress from "alchemy/Egress";

/**
 * What a session's container may reach, and with whose credentials: the
 * model API and GitHub. Declared bare so the Durable Object that yields it
 * stays small; Gateway.aws.ts (AWS) or Gateway.cf.ts (Cloudflare) serves it.
 */
export class Gateway extends Egress.Gateway<Gateway>()("Gateway", {
  model: Anthropic.Egress,
  repo: GitHub.Egress,
}) {}
