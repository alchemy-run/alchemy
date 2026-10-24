import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Egress from "alchemy/Egress";
import * as Effect from "effect/Effect";
import { ECHO_HEADER, ECHO_HOST, ECHO_VALUE, EchoGateway } from "./gateway.ts";

/** Serves {@link EchoGateway}. */
export default class EchoGatewayWorker extends Cloudflare.Worker<EchoGatewayWorker>()(
  "WorkspaceEchoGatewayWorker",
  { main: import.meta.url },
  EchoGateway.serve(
    Effect.gen(function* () {
      return {
        echo: yield* Egress.Http({
          credential: {
            host: ECHO_HOST,
            paths: ["/anything/**"],
            headers: { [ECHO_HEADER]: ECHO_VALUE },
          },
        }),
      };
    }),
  ),
) {}
