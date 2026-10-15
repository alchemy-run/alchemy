import * as Cloudflare from "alchemy/Cloudflare";
import { serveAgentGateway } from "./Gateway.impl.ts";

/**
 * Serves {@link AgentGateway} from a Cloudflare Worker: Durable Objects
 * reach it over a service binding, so a stack with no AWS account can host
 * it. Its github.com requests share Cloudflare's connections, so a slowly
 * read clone can stall the others for a while (Gateway.aws.ts doesn't).
 */
export default class AgentGatewayCf extends Cloudflare.Worker<AgentGatewayCf>()(
  "AgentGateway",
  { main: import.meta.url },
  serveAgentGateway,
) {}
