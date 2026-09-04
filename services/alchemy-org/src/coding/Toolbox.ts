import * as Layer from "effect/Layer";
import { BashLive } from "./Bash.ts";
import { GlobLive } from "./Glob.ts";
import { GrepLive } from "./Grep.ts";
import { ListDirectoryLive } from "./ListDirectory.ts";
import { ReadFileLive } from "./ReadFile.ts";
import { ReadOutputLive } from "../artifacts/ReadOutput.ts";

/**
 * The toolbox, grouped by ACCESS LEVEL — least privilege by
 * composition: Verification = Read + Run (verify, never author);
 * the engineer = Read + Run + the editor (`Editor.ts`, deliberately
 * NOT a member of either group here — the write tools are granted
 * only by that layer, so a reviewer assembled from these two groups
 * alone is a judge by construction).
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
 * Search and read: the eyes.
 */
export const ReadTools = Layer.mergeAll(
  GrepLive,
  GlobLive,
  ListDirectoryLive,
  ReadFileLive,
);

/** Execute and page output: the hands on the REPL. */
export const RunTools = Layer.mergeAll(BashLive, ReadOutputLive);
