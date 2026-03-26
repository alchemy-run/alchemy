import * as Effect from "effect/Effect";
import { FileSystem } from "effect/FileSystem";
import type { Path } from "effect/Path";
import type { Stdio } from "effect/Stdio";
import type { Terminal } from "effect/Terminal";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import type { BaseExecutionContext } from "../ExecutionContext.ts";
import { Platform } from "../Platform.ts";

export type ProcessServices =
  | ChildProcessSpawner
  | FileSystem
  | Path
  | Stdio
  | Terminal;

export interface Process extends Platform.Class<
  Process,
  ProcessContext,
  ProcessServices
> {}

export const Process = Platform<Process>();

export interface ProcessContext extends BaseExecutionContext {
  run: <Req = never, RunReq = never>(
    effect: Effect.Effect<void, never, RunReq>,
  ) => Effect.Effect<void, never, Req | RunReq>;
}
