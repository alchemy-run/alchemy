import * as Cloudflare from "alchemy/Cloudflare";
import { serveGateway } from "./Gateway.impl.ts";

/**
 * Serves {@link Gateway} from a Cloudflare Worker: Durable Objects
 * reach it over a service binding, so a stack with no AWS account can host
 * it. Its github.com requests share Cloudflare's connections, so a slowly
 * read clone can stall the others for a while (Gateway.aws.ts doesn't).
 */
export default class GatewayCf extends Cloudflare.Worker<GatewayCf>()(
  "Gateway",
  { main: import.meta.url },
  serveGateway,
) {}
