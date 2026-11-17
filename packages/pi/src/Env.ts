import { SandboxError as EnvError, type Sandbox } from "@alchemy.run/ai/Sandbox";
import type { Context as ChordContext } from "@earendil-works/chord/context";
import type { EnvTarget as PiEnvTarget } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import * as Effect from "effect/Effect";
import { fromPi } from "./internal/promise.ts";

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

/** A conversation's Pi `ExecutionEnv` as the `AI.Sandbox` its tool calls use. */
export const makeSandbox = (raw: ExecutionEnv): Sandbox["Service"] => ({
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

/** What a tool call's environment is built from: Pi's target, and the instance that owns the conversation. */
export type EnvTarget = PiEnvTarget & {
  /**
   * Identifies the harness instance: the Durable Object's id
   * (`state.id.toString()`), a SQLite file's path. Conversation ids are only
   * unique within one instance, so key anything shared on both.
   */
  readonly instanceId: string;
};

export { EnvError };
