import * as AWS from "@alchemy.run/aws";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as E2B from "@alchemy.run/e2b";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

/**
 * The program every gatewayed sandbox fixture runs, whichever platform the
 * sandbox is on. `E2B.ReadTeam` works on any host and creates an API key
 * for it, so it shows where that key went: the program answers with what
 * the binding returned and what its own environment holds.
 */
export const app = Effect.gen(function* () {
  const team = yield* E2B.ReadTeam();
  return {
    fetch: Effect.gen(function* () {
      const now = Math.floor(Date.now() / 1000);
      const teamId = yield* team.teamId;
      const metrics = yield* team.metrics({ start: now - 3600, end: now });
      // A typed failure of the binding crosses the gateway as itself.
      const failure = yield* team
        .sandboxEvents("not-a-sandbox-id")
        .pipe(Effect.match({ onFailure: (error) => error._tag, onSuccess: () => "none" }));
      const env = yield* Effect.sync(() => process.env);
      return yield* HttpServerResponse.json({
        teamId,
        metrics: Array.isArray(metrics),
        failure,
        // What a program in the sandbox can read.
        apiKey: env.E2B_API_KEY ?? null,
        gateway: env.ALCHEMY_GATEWAY_URL ?? null,
      });
    }).pipe(
      // Say why, so a failing platform's test shows the cause.
      Effect.catchCause((cause) =>
        Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
      ),
    ),
  };
});

/** The program's bindings, built on a Cloudflare Worker gateway. */
export const WorkerGateway = E2B.ReadTeamHttp.pipe(
  Layer.provide(Cloudflare.Workers.SandboxGateway),
);

/** The program's bindings, built on a Lambda Web Function gateway. */
export const WebFunctionGateway = E2B.ReadTeamHttp.pipe(Layer.provide(AWS.Lambda.SandboxGateway));

/** What {@link app} answers. */
export interface Served {
  readonly teamId: string;
  readonly metrics: boolean;
  readonly failure: string;
  readonly apiKey: string | null;
  readonly gateway: string | null;
}
