import * as Anthropic from "alchemy/Anthropic";
import * as Egress from "alchemy/Egress";
import * as GitHub from "alchemy/GitHub";

/**
 * What a session's container may reach, and with whose credentials: the
 * model API and GitHub. Declared bare so the Durable Object that yields it
 * stays small; gateway.worker.ts serves it.
 */
export class AgentGateway extends Egress.Gateway<AgentGateway>()("AgentGateway", {
  model: Anthropic.Egress,
  repo: GitHub.Egress,
}) {}
