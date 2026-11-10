import type { Context as ChordContext } from "@earendil-works/chord/context";
import type { EnvTarget } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { fromPi } from "./internal/promise.ts";

/** A file operation or command in the conversation's environment failed. */
export class EnvError extends Data.TaggedError("EnvError")<{
  readonly operation: string;
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}> {}

/** What a command printed, and its exit code. */
export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ExecOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  /** Milliseconds before the command is killed. */
  readonly timeout?: number;
}

/**
 * The environment a tool call works in: the conversation's files and shell.
 * Provided to every tool handler for the duration of its call.
 */
export class Env extends Context.Service<
  Env,
  {
    /** Run a program (an argument vector) or a shell line to completion. */
    readonly exec: (
      command: string | ReadonlyArray<string>,
      options?: ExecOptions,
    ) => Effect.Effect<ExecResult, EnvError>;
    readonly readFile: (path: string) => Effect.Effect<Uint8Array, EnvError>;
    readonly readTextFile: (path: string) => Effect.Effect<string, EnvError>;
    readonly writeFile: (
      path: string,
      content: string | Uint8Array,
    ) => Effect.Effect<void, EnvError>;
    /** The raw Pi environment, for operations this view doesn't cover. */
    readonly raw: ExecutionEnv;
  }
>()("Pi.Env") {}

type PiResult<A> =
  | { ok: true; value: A }
  | { ok: false; error: { code: string; message: string; path?: string } };

const unwrap = <A>(operation: string, call: (context: ChordContext) => Promise<PiResult<A>>) =>
  fromPi(call).pipe(
    Effect.mapError(
      (error) => new EnvError({ operation, code: "unknown", message: error.message }),
    ),
    Effect.flatMap((result) =>
      result.ok
        ? Effect.succeed(result.value)
        : Effect.fail(
            new EnvError({
              operation,
              code: result.error.code,
              message: result.error.message,
              ...(result.error.path !== undefined ? { path: result.error.path } : {}),
            }),
          ),
    ),
  );

/** The Effect view of a Pi `ExecutionEnv`. */
export const makeEnv = (raw: ExecutionEnv): Env["Service"] => ({
  raw,
  exec: (command, options) =>
    Effect.suspend(() => {
      let stdout = "";
      let stderr = "";
      return unwrap("exec", (context) =>
        raw.exec(
          command as string | readonly string[],
          {
            ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
            ...(options?.env !== undefined ? { env: options.env } : {}),
            ...(options?.timeout !== undefined ? { timeout: options.timeout } : {}),
            onOutput: (text, _context, info) => {
              if (info.stream === "stdout") stdout += text;
              else stderr += text;
            },
          },
          context,
        ),
      ).pipe(Effect.map(({ exitCode }) => ({ exitCode, stdout, stderr })));
    }),
  readFile: (path) => unwrap("readFile", (context) => raw.readBinaryFile(path, context)),
  readTextFile: (path) => unwrap("readTextFile", (context) => raw.readTextFile(path, context)),
  writeFile: (path, content) =>
    unwrap("writeFile", (context) => raw.writeFile(path, content, context)),
});

/**
 * Where a conversation's tools run: builds the Pi `ExecutionEnv` for each
 * tool call from the conversation's id and working directory. Provide one
 * of `Pi.LocalEnv`, `Pi.NoEnv`, or a sandbox environment.
 */
export class EnvHost extends Context.Service<
  EnvHost,
  {
    readonly make: (target: EnvTarget) => Effect.Effect<ExecutionEnv | undefined, EnvError>;
  }
>()("Pi.EnvHost") {}

/**
 * No files and no shell: the built-in coding tools answer with an error,
 * and only your own tools run. For agents that only call APIs.
 *
 * @layer
 * @provides Pi.EnvHost
 */
export const NoEnv: Layer.Layer<EnvHost> = Layer.succeed(EnvHost, {
  make: () => Effect.succeed(undefined),
});

/**
 * Tools run on this machine, in `cwd` or the conversation's own working
 * directory. Needs Node or Bun (a Fly Machine, an ECS task, a container).
 *
 * @layer
 * @provides Pi.EnvHost
 */
export const LocalEnv = (options: { readonly cwd: string }): Layer.Layer<EnvHost> =>
  Layer.succeed(EnvHost, {
    make: (target) =>
      Effect.tryPromise({
        try: async () => {
          const { NodeExecutionEnv } = await import("@earendil-works/pi-durable/env/node");
          return new NodeExecutionEnv({ cwd: target.cwd ?? options.cwd });
        },
        catch: (cause) =>
          new EnvError({
            operation: "open",
            code: "unknown",
            message: `Pi.LocalEnv needs Node or Bun: ${String(cause)}`,
          }),
      }),
  });
