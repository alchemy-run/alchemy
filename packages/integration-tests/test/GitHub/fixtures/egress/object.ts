import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { EgressBox } from "./box.ts";
import { GitHubEgressGateway } from "./gateway.ts";
import { EGRESS_REPO } from "./repo.ts";

export interface Shell {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs scripts in its container, whose GitHub access goes through the gateway. */
export class EgressObject extends Cloudflare.DurableObject<EgressObject>()(
  "GitHubEgressObject",
  Effect.gen(function* () {
    const box = yield* EgressBox;
    const gateway = yield* GitHubEgressGateway;
    return Effect.gen(function* () {
      const { fetch } = yield* box.getTcpPort(3000);
      const sh = (script: string) =>
        fetch(
          HttpClientRequest.post("http://container/sh").pipe(HttpClientRequest.bodyText(script)),
        ).pipe(
          Effect.flatMap((response) => response.json),
          Effect.map((body) => body as unknown as Shell),
        );
      return {
        /** With the declared access. */
        run: (script: string) =>
          box.start({ size: "small", egress: [gateway.repo] }).pipe(Effect.andThen(sh(script))),
        /** Narrowed to one issue. */
        runOnIssue: (issue: number, script: string) =>
          box
            .start({
              size: "small",
              egress: [gateway.repo.narrow({ repository: EGRESS_REPO, issue })],
            })
            .pipe(Effect.andThen(sh(script))),
      };
    });
  }),
) {}
