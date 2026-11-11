import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { EnvironmentConfig } from "./EnvironmentConfig.ts";

/** A Harness Runtime call failed. */
export class SessionError extends Data.TaggedError("DigitalOcean.Agents.SessionError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message() {
    return `Harness session ${this.operation} failed: ${String(this.cause)}`;
  }
}

/** The environment config or the token is missing from this runtime. */
export class SessionBindingNotConfigured extends Data.TaggedError(
  "DigitalOcean.Agents.SessionBindingNotConfigured",
)<{}> {
  override get message() {
    return "No Harness Runtime environment or token is bound to this runtime.";
  }
}

/** The result of a command in the session's sandbox. */
export interface SessionExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** One running agent session. */
export interface SessionHandle {
  readonly sessionId: string;
  /** `SESSION_STATUS_READY`, `SESSION_STATUS_PAUSED`, ... */
  readonly status: Effect.Effect<string, SessionError, RuntimeContext>;
  /** Sends a user turn to the agent; returns the run id. */
  send(text: string): Effect.Effect<string | undefined, SessionError, RuntimeContext>;
  /** Stops the turn in flight. */
  readonly cancel: Effect.Effect<void, SessionError, RuntimeContext>;
  /** Runs a command in the session's sandbox. */
  exec(
    argv: ReadonlyArray<string>,
    options?: { readonly cwd?: string; readonly timeoutSeconds?: number },
  ): Effect.Effect<SessionExecResult, SessionError, RuntimeContext>;
  /** Pauses the sandbox, keeping its state. */
  readonly pause: Effect.Effect<void, SessionError, RuntimeContext>;
  /** Resumes a paused sandbox. */
  readonly resume: Effect.Effect<void, SessionError, RuntimeContext>;
  /** Captures the sandbox's machine state; returns the checkpoint id. */
  checkpoint(label?: string): Effect.Effect<string | undefined, SessionError, RuntimeContext>;
  /**
   * Starts `count` (1-4) child sessions from a checkpoint of this one, or
   * from its state now when no checkpoint is given.
   */
  fork(options?: {
    readonly fromCheckpointId?: string;
    readonly count?: number;
  }): Effect.Effect<ReadonlyArray<SessionHandle>, SessionError, RuntimeContext>;
  /** Answers a human-in-the-loop request the agent raised. */
  resolve(
    requestId: string,
    outcome: "approve" | "reject" | "defer",
    reason?: string,
  ): Effect.Effect<void, SessionError, RuntimeContext>;
  /** Destroys the session and its sandbox. */
  readonly delete: Effect.Effect<void, SessionError, RuntimeContext>;
}

/** Sessions from one environment config. */
export interface SessionsClient {
  create(options?: {
    readonly name?: string;
    readonly region?: string;
  }): Effect.Effect<SessionHandle, SessionError | SessionBindingNotConfigured, RuntimeContext>;
  get(
    sessionId: string,
  ): Effect.Effect<SessionHandle, SessionError | SessionBindingNotConfigured, RuntimeContext>;
}

/**
 * Starts Harness Runtime agent sessions from an environment config at run
 * time: each session gets an isolated sandbox running the config's agent.
 * DigitalOcean has no API to mint a token a runtime could use, so pass one
 * (a personal access token with the `agents` scopes); it reaches the host
 * as a secret.
 *
 * **Example:** One agent session per request
 * ```typescript
 * const Coder = DigitalOcean.Agents.EnvironmentConfig("coder", {
 *   manifest: {
 *     apiVersion: "agents.digitalocean.com/v1alpha1",
 *     kind: "Agent",
 *     spec: { runtime: { adapter: "opencode" } },
 *   },
 * });
 *
 * export default class Api extends DigitalOcean.App<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const env = yield* Coder;
 *     const token = yield* Config.Redacted("DO_AGENTS_TOKEN");
 *     const sessions = yield* DigitalOcean.Agents.CreateSession(env, { token });
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const session = yield* Effect.acquireRelease(sessions.create(), (s) =>
 *           Effect.ignore(s.delete),
 *         );
 *         yield* session.send("Write hello.txt containing 'hi'.");
 *         const out = yield* session.exec(["cat", "hello.txt"]);
 *         return HttpServerResponse.text(out.stdout);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(DigitalOcean.Agents.CreateSessionHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Harness Runtime
 */
export interface CreateSession extends Binding.Service<
  CreateSession,
  "DigitalOcean.Agents.CreateSession",
  (
    env: EnvironmentConfig,
    options: { readonly token: Redacted.Redacted<string> },
  ) => Effect.Effect<SessionsClient>
> {}

export const CreateSession = Binding.Service<CreateSession>("DigitalOcean.Agents.CreateSession");
