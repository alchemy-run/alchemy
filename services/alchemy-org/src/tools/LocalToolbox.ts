/**
 * The LOCAL toolbox, grouped by ACCESS LEVEL — the same
 * read/write/read-write convention alchemy's capability bindings use,
 * applied to tool physics. Skills compose least privilege:
 *
 * - Coding      = Read + Run + Write (the full keyboard)
 * - QualityAssurance = Read + Run    (verify, never author)
 *
 * All groups share ONE support layer (module const — Layer memoization
 * by reference dedupes it across groups in a composition).
 */
import * as Layer from "effect/Layer";
import { WorkspaceFilesLive } from "alchemy/Workspace";
import { ToolOutputStoreLive } from "../lib/ToolOutputStore.ts";
import {
  ApplyPatchLocal,
  BashLocal,
  EditFileLocal,
  GlobLocal,
  GrepLocal,
  ListDirectoryLocal,
  ReadFileLocal,
  ReadOutputLocal,
  WriteFileLocal,
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

/** Structured mutation: the pen. */
export const WriteToolsLocal = Layer.mergeAll(
  EditFileLocal,
  ApplyPatchLocal,
  WriteFileLocal,
).pipe(Layer.provide(LocalSupport));
