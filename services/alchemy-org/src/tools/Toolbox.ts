import * as Layer from "effect/Layer";
import {
  BashLive,
  EditFileLive,
  GlobLive,
  GrepLive,
  ListDirectoryLive,
  ReadFileLive,
  ReadOutputLive,
  WriteFileLive,
} from "./index.ts";

/**
 * The toolbox, grouped by ACCESS LEVEL — least privilege by
 * composition: QualityAssurance = Read + Run (verify, never author);
 * the Bootstrap = Read + Run + Write (it authors ITSELF).
 *
 * Every tool's physics runs over the session {@link AI.Sandbox}, so
 * the same groups work on the trusted host (SandboxLocal), in a
 * Cloudflare Container, or in a MicroVM — the placement is decided
 * where the Sandbox Layer is provided, not here. The groups also
 * leave `Artifacts` (artifact retention for truncated output)
 * as a REQUIREMENT: the local assembly provides the host tmp-dir
 * store, the Cloudflare assembly provides the sandbox-file store —
 * baking one in here would weld the groups to one substrate.
 *
 Search and read: the eyes.
 */
export const ReadTools = Layer.mergeAll(
  GrepLive,
  GlobLive,
  ListDirectoryLive,
  ReadFileLive,
);

/** Execute and page output: the hands on the REPL. */
export const RunTools = Layer.mergeAll(BashLive, ReadOutputLive);

/** Author files: the pen — digest-guarded edits and whole-file writes. */
export const WriteTools = Layer.mergeAll(EditFileLive, WriteFileLive);
