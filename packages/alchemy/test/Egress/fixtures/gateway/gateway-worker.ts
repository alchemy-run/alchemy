import * as Effect from "effect/Effect";
import * as Cloudflare from "@/Cloudflare";
import * as Egress from "@/Egress/index.ts";
import * as GitHub from "@/GitHub/index.ts";
import { ECHO_HEADER, ECHO_HOST, ECHO_VALUE, READ_REPO, TestGateway } from "./gateway.ts";

/** Serves {@link TestGateway}: read-only GitHub with the profile token, and an echo host. */
export default class GatewayWorker extends Cloudflare.Worker<GatewayWorker>()(
  "EgressGatewayWorker",
  { main: import.meta.url },
  TestGateway.serve(
    Effect.gen(function* () {
      return {
        repo: yield* GitHub.Egress({
          token: GitHub.ProfileToken,
          repositories: [{ repository: READ_REPO, contents: "read" }],
        }),
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
