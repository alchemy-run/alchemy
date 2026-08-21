/**
 * The driver fixture WITH a per-session container attached: the same
 * Scribe-over-DriverCloudflare org as `DriverWorker.ts`, plus the
 * {@link Cloudflare.AI.SessionContainerImage} reference — so the
 * sessions Durable Object binds the sandbox container to its namespace
 * at plan time (the alchemy-org topology). The charters never touch
 * the sandbox: this fixture pins that a worker whose session DO merely
 * HAS a container attached still boots and serves.
 */
import * as AI from "@/AI/index.ts";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as S from "effect/Schema";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {
  DeterministicModel,
  LoggingObserver,
  Scribe,
  ScribeLive,
} from "./DriverAgents.ts";

// ── the sandbox-touching agent: the alchemy-org shape ─────────────

export const cmd = AI.Parameter("cmd", S.String)`
The shell command to run on the machine.`;

export class Probe extends (AI.Tool<Probe>()("probe")`
Run ${cmd} on your machine and reply with what it printed.`) {}

/** The tool's physics: the session's own container, started on first
 *  use — exactly the org's toolbox topology. */
export const ProbeLive = Layer.effect(
  Probe,
  Effect.gen(function* () {
    const sandbox = yield* AI.Sandbox;
    return ((input: { cmd: string }) =>
      Effect.gen(function* () {
        const result = yield* sandbox
          .exec(input.cmd, undefined, { timeout: 120_000 })
          .pipe(Effect.mapError((error) => String(error)));
        yield* AI.reply({
          stdout: result.stdout.trim(),
          exitCode: result.exitCode,
        });
        return `exit ${result.exitCode}`;
      })) as never;
  }),
).pipe(
  // enableInternet matches the org's SandboxSession: in dev this is the
  // path that needs the egress interceptor machinery
  Layer.provide(
    Cloudflare.AI.SandboxContainerSession({ enableInternet: true }),
  ),
);

export class Machinist extends AI.Agent<Machinist>()("Machinist") {}

export const MachinistLive = Machinist.make(
  AI.fragment`
    You operate the machine. Run whatever you are asked with ${Probe}.
  `,
).pipe(Layer.provide(ProbeLive));

const Agents = Layer.mergeAll(ScribeLive, MachinistLive).pipe(
  Layer.provideMerge(
    Cloudflare.AI.DriverCloudflare.pipe(
      // the org topology under test: every session's DO carries the
      // sandbox container attachment
      Layer.provide(
        Layer.succeed(
          Cloudflare.AI.SessionContainerImage,
          Cloudflare.AI.SandboxContainerImage,
        ),
      ),
    ),
  ),
  Layer.provideMerge(
    Layer.mergeAll(
      DeterministicModel,
      LoggingObserver,
      Layer.succeed(MinimumLogLevel, "Debug"),
    ),
  ),
);

export default class DriverContainerTestWorker extends Cloudflare.Worker<DriverContainerTestWorker>()(
  "DriverContainerTestWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const scribe = yield* Scribe;
    const machinist = yield* Machinist;
    const sessions = yield* Cloudflare.AI.Sessions;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        const key = url.searchParams.get("key") ?? "default";
        const input = url.searchParams.get("input") ?? "hello";
        const dispatch = (actor: typeof scribe) =>
          Effect.gen(function* () {
            const result = yield* Effect.exit(actor.dispatch(input, { key }));
            if (Exit.isSuccess(result)) {
              return yield* HttpServerResponse.json({ answer: result.value });
            }
            const detail = Cause.pretty(result.cause);
            yield* Effect.logError(`[fixture] dispatch failed: ${detail}`);
            return yield* HttpServerResponse.json(
              { error: detail },
              { status: 500 },
            );
          });

        switch (url.pathname) {
          case "/health":
            return yield* HttpServerResponse.json({ ok: true });
          case "/sessions":
            return yield* HttpServerResponse.json(yield* sessions.list());
          case "/dispatch":
            return yield* dispatch(scribe);
          // the sandbox path: the Machinist's probe tool execs on the
          // session's OWN container (started on first use)
          case "/exec":
            return yield* dispatch(machinist);
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(Effect.provide(Agents)),
) {}
