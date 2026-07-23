/**
 * The Coding skill — the craft of writing code in the repository
 * checkout, packaged: the tools AND the discipline for using them.
 *
 * Referencing ${Coding} in a charter grants ACCESS, nominally: the
 * charter's requirement is `Coding` — never the individual tools —
 * and providing {@link CodingLive} is what surfaces `Grep | ReadFile
 * | EditFile | Bash` as requirements. The skill stays dormant until
 * the agent activates it, or a spawner hands it to a worker
 * pre-activated. Which physics answers (local FileSystem/shell in
 * toolbox.ts today, a DevBox container later) stays an entrypoint
 * decision.
 */
import * as AI from "alchemy/AI";
import * as Layer from "effect/Layer";
import { ToolOutputStoreLive } from "./internal/ToolOutputStore.ts";
import { WorkspaceFilesLive } from "./internal/WorkspaceFiles.ts";
import {
  ApplyPatch,
  ApplyPatchLocal,
  Bash,
  BashLocal,
  EditFile,
  EditFileLocal,
  Glob,
  GlobLocal,
  Grep,
  GrepLocal,
  ListDirectory,
  ListDirectoryLocal,
  ReadFile,
  ReadFileLocal,
  ReadOutput,
  ReadOutputLocal,
  WriteFile,
  WriteFileLocal,
} from "./tools/index.ts";

export class Coding extends AI.Skill<Coding>()("Coding") {}

/**
 * The teaching: the discipline AND the tools it grants, on the LAYER
 * — a different environment may make the same contract with different
 * prose over different tools.
 * `Layer<Coding, never, Grep | Glob | ListDirectory | ReadFile |
 * EditFile | ApplyPatch | WriteFile | Bash | ReadOutput>`.
 */
export const CodingLive = Coding.make`
  Writing code in the repository checkout. ${Grep} before you
  ${ReadFile}; use ${Glob} for filenames and ${ListDirectory} for
  shallow orientation. ${ReadFile} returns the digest required before
  you touch an existing file. ${EditFile} applies atomic exact-string
  edits; ${ApplyPatch} coordinates guarded multi-file add/update/delete
  or move operations; ${WriteFile} is for new files and complete
  rewrites only. ${Bash} runs the test suite after every edit; when
  search or command output is truncated, page the retained artifact
  with ${ReadOutput}. The suite is the only oracle of done-ness.`;

/**
 * Production local/Bun tool composition. The entrypoint still chooses
 * the {@link Workspace} root and provides platform services; this
 * Layer owns one shared file service and one scoped output store.
 */
const LocalSupport = Layer.mergeAll(WorkspaceFilesLive, ToolOutputStoreLive);

const LocalTools = Layer.mergeAll(
  GrepLocal,
  GlobLocal,
  ListDirectoryLocal,
  ReadFileLocal,
  EditFileLocal,
  ApplyPatchLocal,
  WriteFileLocal,
  BashLocal,
  ReadOutputLocal,
).pipe(Layer.provide(LocalSupport));

export const CodingLocal = CodingLive.pipe(Layer.provide(LocalTools));
