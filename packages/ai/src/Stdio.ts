import * as JsonRpc from "@distilled.cloud/core/jsonrpc";
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import type * as Scope from "effect/Scope";
import { SessionError } from "./Session.ts";

/**
 * Spawn a harness process (`opencode acp`, `codex app-server`, …) in the
 * enclosing scope and expose its stdio as a JSON-RPC transport. Distilled
 * only speaks the protocol; starting the process is the host's job.
 */
export const spawnStdio = (options: {
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly env?: Record<string, string | undefined>;
}): Effect.Effect<JsonRpc.Transport, SessionError, ChildProcessSpawner | Scope.Scope> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner;
    const handle = yield* spawner
      .spawn(
        ChildProcess.make(options.command, [...(options.args ?? [])], {
          ...(options.env ? { env: options.env as Record<string, string> } : {}),
          extendEnv: true,
          stderr: "inherit",
        }),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new SessionError({ message: `failed to start ${options.command}: ${String(cause)}` }),
        ),
      );
    return JsonRpc.fromStreams({ readable: handle.stdout, writable: handle.stdin });
  });
