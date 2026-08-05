/**
 * The LOCAL toolbox, grouped by ACCESS LEVEL. The review bot composes
 * least privilege: QualityAssurance = Read + Run — verify, never
 * author (there is deliberately no Write group here).
 *
 * Both groups share ONE support layer (module const — Layer
 * memoization by reference dedupes it across groups in a composition).
 */
import * as Layer from "effect/Layer";
import { WorkspaceFilesLive } from "alchemy/Workspace";
import { ToolOutputStoreLive } from "../lib/ToolOutputStore.ts";
import {
  BashLocal,
  GlobLocal,
  GrepLocal,
  ListDirectoryLocal,
  ReadFileLocal,
  ReadOutputLocal,
} from "./index.ts";

const LocalSupport = Layer.mergeAll(WorkspaceFilesLive, ToolOutputStoreLive);

/** Search and read: the eyes. */
export const ReadToolsLocal = Layer.mergeAll(
  GrepLocal,
  GlobLocal,
  ListDirectoryLocal,
  ReadFileLocal,
).pipe(Layer.provide(LocalSupport));

/** Execute and page output: the hands on the REPL — note Bash is
 * trusted-host execution, not a sandbox; "no editor" is a statement
 * about the structured edit tools, prose covers the rest. */
export const RunToolsLocal = Layer.mergeAll(BashLocal, ReadOutputLocal).pipe(
  Layer.provide(LocalSupport),
);
