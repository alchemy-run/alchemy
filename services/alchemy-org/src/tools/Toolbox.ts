/**
 * The toolbox, grouped by ACCESS LEVEL — least privilege by
 * composition: QualityAssurance = Read + Run (verify, never author);
 * the Bootstrap = Read + Run + Write (it authors ITSELF).
 *
 * Every tool's physics runs over the session {@link AI.Sandbox}, so
 * the same groups work on the trusted host (SandboxLocal), in a
 * Cloudflare Container, or in a MicroVM — the placement is decided
 * where the Sandbox Layer is provided, not here. The shared support
 * layer (artifact retention for truncated output) is a module const
 * so Layer memoization dedupes it across groups.
 */
import * as Layer from "effect/Layer";
import { ToolOutputStoreLive } from "../lib/ToolOutputStore.ts";
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

const Support = ToolOutputStoreLive;

/** Search and read: the eyes. */
export const ReadTools = Layer.mergeAll(
  GrepLive,
  GlobLive,
  ListDirectoryLive,
  ReadFileLive,
).pipe(Layer.provide(Support));

/** Execute and page output: the hands on the REPL. */
export const RunTools = Layer.mergeAll(BashLive, ReadOutputLive).pipe(
  Layer.provide(Support),
);

/** Author files: the pen — digest-guarded edits and whole-file writes. */
export const WriteTools = Layer.mergeAll(EditFileLive, WriteFileLive);
