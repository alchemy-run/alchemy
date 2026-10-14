import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Cloudflare from "@/Cloudflare";
import * as GitHub from "@/GitHub/index.ts";
import { GATEWAY_HEADER, MicrovmSandboxGateway, REPO_A, REPO_B } from "./gateway.ts";

/** Serves {@link MicrovmSandboxGateway}: reads both repositories with the profile's token. */
export default class MicrovmSandboxGatewayWorker extends Cloudflare.Worker<MicrovmSandboxGatewayWorker>()(
  "MicrovmSandboxGatewayWorker",
  { main: import.meta.url },
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
