import * as AWS from "alchemy/AWS";
import * as Duration from "effect/Duration";
import { serveGateway } from "./Gateway.impl.ts";

/**
 * Serves {@link Gateway} from a Lambda Web Function, in every Region in
 * `regions` (one global domain, routed to the nearest).
 *
 * The default host: a Worker's requests to github.com share Cloudflare's
 * connections, so one slowly read clone stalls the gateway's other GitHub
 * requests (Gateway.cf.ts has the same rules on a Worker).
 */
export default class GatewayAws extends AWS.Lambda.WebFunction<GatewayAws>()(
  "Gateway",
  {
    main: import.meta.url,
    authType: "ApplicationManaged",
    regions: ["us-east-1", "eu-west-1", "ap-northeast-1"],
    // A clone, or a model's streamed answer, runs as long as it takes.
    timeout: Duration.minutes(15),
  },
  serveGateway,
) {}
