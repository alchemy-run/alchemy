import * as DO from "@distilled.cloud/digitalocean";
import * as Output from "alchemy/Output";
import { CurrentRuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import {
  CreateSession,
  SessionBindingNotConfigured,
  SessionError,
  type SessionHandle,
  type SessionsClient,
} from "./CreateSession.ts";
import type { EnvironmentConfig } from "./EnvironmentConfig.ts";

const envKey = (env: EnvironmentConfig, field: string) =>
  `DO_AGENTS_${env.LogicalId}_${field}`.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_");

/**
 * `CreateSession` over the Harness Runtime API, signed with the token the
 * host was given.
 *
 * @layer
 * @product Harness Runtime
 * @provides DigitalOcean.Agents.CreateSession
 */
export const CreateSessionHttp = Layer.succeed(
  CreateSession,
  Effect.fn(function* (
    env: EnvironmentConfig,
    options: { readonly token: Redacted.Redacted<string> },
  ) {
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      const runtime = yield* CurrentRuntimeContext;
      if (runtime !== undefined) {
        yield* runtime.set(envKey(env, "token"), Output.literal(options.token));
        yield* runtime.set(envKey(env, "config"), env.configId);
      }
    }
    // Read in the construction phase, where the host's runtime context is
    // present; request handlers close over the values.
    const runtime = globalThis.__ALCHEMY_RUNTIME__ ? yield* CurrentRuntimeContext : undefined;
    const token =
      runtime === undefined
        ? undefined
        : yield* runtime.get<string | Redacted.Redacted<string>>(envKey(env, "token"));
    const configId =
      runtime === undefined ? undefined : yield* runtime.get<string>(envKey(env, "config"));
    const layer =
      token === undefined
        ? undefined
        : Layer.mergeAll(
            DO.fromApiKey({ apiKey: typeof token === "string" ? Redacted.make(token) : token }),
            FetchHttpClient.layer,
          );

    const call = <A, E>(
      operation: string,
      effect: Effect.Effect<A, E, DO.DigitalOceanOpContext>,
    ) =>
      layer === undefined
        ? Effect.fail(new SessionError({ operation, cause: "not bound" }))
        : effect.pipe(
            Effect.provide(layer),
            Effect.mapError((cause) => new SessionError({ operation, cause })),
          );

    const handle = (sessionId: string): SessionHandle => ({
      sessionId,
      status: call(
        "status",
        DO.getHarnessSession({ session_id: sessionId }).pipe(
          Effect.map((r) => r.session?.status ?? "SESSION_STATUS_UNSPECIFIED"),
        ),
      ),
      send: (text) =>
        call(
          "send",
          DO.createHarnessSessionInput({ session_id: sessionId, text }).pipe(
            Effect.map((r) => r.run_id),
          ),
        ),
      cancel: call("cancel", DO.cancelHarnessSessionTurn({ session_id: sessionId })).pipe(
        Effect.asVoid,
      ),
      exec: (argv, execOptions) =>
        call(
          "exec",
          DO.harnessPostSessionSandboxExec({
            session_id: sessionId,
            argv: [...argv],
            workdir: execOptions?.cwd,
            timeout_seconds: execOptions?.timeoutSeconds,
          }).pipe(
            Effect.map((r) => ({
              exitCode: r.exit_code ?? 0,
              stdout: r.stdout ?? "",
              stderr: r.stderr ?? "",
            })),
          ),
        ),
      pause: call("pause", DO.postHarnessSessionPause({ session_id: sessionId })).pipe(
        Effect.asVoid,
      ),
      resume: call("resume", DO.harnessPostSessionResume({ session_id: sessionId })).pipe(
        Effect.asVoid,
      ),
      checkpoint: (label) =>
        call(
          "checkpoint",
          DO.createHarnessSessionCheckpoint({ session_id: sessionId, label }).pipe(
            Effect.map((r) => r.checkpoint?.checkpoint_id),
          ),
        ),
      fork: (forkOptions) =>
        call(
          "fork",
          DO.createHarnessSessionFork({
            session_id: sessionId,
            from_checkpoint_id: forkOptions?.fromCheckpointId,
            count: forkOptions?.count,
          }).pipe(
            Effect.map((r) =>
              (r.sessions ?? []).flatMap((child) =>
                child.session_id === undefined ? [] : [handle(child.session_id)],
              ),
            ),
          ),
        ),
      resolve: (requestId, outcome, reason) =>
        call(
          "resolve",
          DO.postHarnessSessionHitl({
            session_id: sessionId,
            request_id: requestId,
            outcome: `HITL_OUTCOME_${outcome.toUpperCase()}`,
            reason,
          }),
        ).pipe(Effect.asVoid),
      delete: call(
        "delete",
        DO.deleteHarnessSession({ session_id: sessionId }).pipe(
          Effect.catchTag("NotFound", () => Effect.void),
        ),
      ).pipe(Effect.asVoid),
    });

    return {
      create: (createOptions) =>
        configId === undefined
          ? Effect.fail(new SessionBindingNotConfigured())
          : Effect.gen(function* () {
              const name =
                createOptions?.name ??
                (yield* Effect.sync(() => `session-${crypto.randomUUID().slice(0, 8)}`));
              const created = yield* call(
                "create",
                DO.createHarnessSession({
                  name,
                  config_id: configId,
                  region: createOptions?.region,
                }),
              );
              return handle(created.session.session_id ?? "");
            }),
      get: (sessionId) =>
        configId === undefined
          ? Effect.fail(new SessionBindingNotConfigured())
          : Effect.succeed(handle(sessionId)),
    } satisfies SessionsClient;
  }),
);
