import * as Effect from "effect/Effect";
import * as AWS from "@/AWS";
import * as GitHub from "@/GitHub/index.ts";
import { LambdaTestGateway, READ_REPO } from "./gateway.ts";

/**
 * Serves {@link LambdaTestGateway} on a Lambda: the sandbox's traffic over
 * the function URL, `mint` on a direct invoke only.
 */
export default class LambdaGatewayFunction extends AWS.Lambda.Function<LambdaGatewayFunction>()(
  "EgressLambdaGatewayFunction",
  { main: import.meta.url, functionUrl: true },
  LambdaTestGateway.serve(
    Effect.gen(function* () {
      return {
        repo: yield* GitHub.Egress({
          token: GitHub.ProfileToken,
          repositories: [{ repository: READ_REPO, contents: "read" }],
        }),
      };
    }),
  ),
) {}
