import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { applyPatch } from "../patch/apply.ts";
import { expectedDigests, patchText } from "../patch/parameters.ts";
import type { ApplyPatchInput } from "../patch/types.ts";
import { Workspace } from "../workspace.ts";

/**
 * Apply a structured multi-file patch after validating the complete change.
 *
 * The local implementation parses and preflights every operation against a
 * virtual workspace, verifies source digests, stages all resulting files, and
 * only then mutates disk. Commit rollback is best-effort because portable
 * filesystems do not provide a transaction spanning multiple paths.
 */
export class ApplyPatch extends AI.Tool<ApplyPatch>()("applyPatch")`
Apply ${patchText} as one guarded workspace change. Supply
${expectedDigests} for optimistic concurrency. Use this for coordinated
multi-file edits, creates, deletes, or moves. The entire patch is parsed,
path-checked, digest-checked, and simulated before disk mutation.

The patch format is:
*** Begin Patch
*** Add File: relative/path
+every added line starts with +
*** Update File: relative/path
*** Move to: optional/new/path
@@ optional class or function anchor
 unchanged context starts with one space
-removed text starts with -
+added text starts with +
*** Delete File: relative/path
*** End Patch

Use workspace-relative paths only. Include about three lines of
context before and after each update. When context repeats, use an
@@ class/function anchor (multiple anchors may progressively seek).
Use "*** End of File" only to intentionally anchor the preceding hunk
at EOF. Every existing Update/Delete source must have the digest from
readFile; newly added files do not.

Matching follows Codex apply-patch behavior: ordered hunks try exact
context first, then trailing-whitespace-insensitive, fully trimmed, and
Unicode punctuation/space-normalized matching. Prefer generous exact
context. On success, the result lists A/M/D paths. On failure, fix the
reported patch line or re-read stale files; do not retry a stale patch.
Staged writes use best-effort rollback, not a filesystem transaction.` {}

/** Local physics over the current Workspace checkout. */
export const ApplyPatchLocal = Layer.effect(
  ApplyPatch,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const workspace = yield* Workspace;
    return ((input: ApplyPatchInput) =>
      Effect.flatMap(workspace.root, (root) =>
        applyPatch(input, fs, pathService, {
          root,
          resolve: workspace.resolve,
        }),
      )) as never;
  }),
);
