import * as AWS from "@alchemy.run/aws";
import * as GitHub from "@alchemy.run/github";
import * as Effect from "effect/Effect";
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
