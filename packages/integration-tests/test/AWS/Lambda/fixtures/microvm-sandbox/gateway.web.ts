import * as Lambda from "@alchemy.run/aws/Lambda";
import * as GitHub from "@alchemy.run/github";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { GATEWAY_HEADER, MicrovmSandboxGateway, REPO_A, REPO_B } from "./gateway.ts";

/**
 * Serves {@link MicrovmSandboxGateway} from a Lambda Web Function in four
 * Regions: reads both repositories with the profile's token.
 */
export default class MicrovmSandboxGatewayWeb extends Lambda.WebFunction<MicrovmSandboxGatewayWeb>()(
  "MicrovmSandboxGatewayWeb",
  {
    main: import.meta.url,
    authType: "ApplicationManaged",
    regions: ["us-east-1", "eu-west-1", "ap-northeast-1"],
    // A clone streams for as long as it takes.
    timeout: Duration.minutes(15),
  },
  MicrovmSandboxGateway.serve(
    Effect.gen(function* () {
      return {
        repo: yield* GitHub.Egress({
          token: GitHub.ProfileToken,
          repositories: [
            { repository: REPO_A, contents: "read" },
            { repository: REPO_B, contents: "read" },
          ],
        }),
      };
    }),
  ).pipe(
    Effect.map((server) => ({
      ...server,
      fetch: server.fetch.pipe(
        Effect.map((response) => HttpServerResponse.setHeader(response, GATEWAY_HEADER, "1")),
      ),
    })),
  ),
) {}
