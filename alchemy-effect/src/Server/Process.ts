import { FileSystem } from "effect/FileSystem";
import type { Path } from "effect/Path";
import type { Stdio } from "effect/Stdio";
import type { Terminal } from "effect/Terminal";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { Platform } from "../Platform.ts";
import * as Server from "./ExecutionContext.ts";

/** Services installed by `make` around the implementation effect. */
type ProcessRuntimeServices =
  | Server.Context
  | ChildProcessSpawner
  | FileSystem
  | Path
  | Stdio
  | Terminal;

export interface Process extends Platform<Server.ExecutionContext> {}

export const Process = Platform<Process>();
