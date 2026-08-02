/**
 * The Coding skill — the craft of writing code in the repository
 * checkout, packaged: the tools AND the discipline for using them.
 *
 * Substrate compositions live in CodingLocal.ts / CodingWorker.ts so
 * each entrypoint only pulls its own physics into the bundle.
 */
import * as AI from "alchemy/AI";
import * as Layer from "effect/Layer";
import {
  ApplyPatch,
  Bash,
  EditFile,
  Glob,
  Grep,
  ListDirectory,
  ReadFile,
  ReadOutput,
  WriteFile,
} from "../tools/index.ts";
import {
  ReadToolsLocal,
  RunToolsLocal,
  WriteToolsLocal,
} from "../tools/LocalToolbox.ts";
import {
  ReadToolsSandbox,
  RunToolsSandbox,
  WriteToolsSandbox,
} from "../tools/SandboxToolbox.ts";

import { ResourceEngineering } from "./ResourceEngineering.ts";

export class Coding extends AI.Skill<Coding>()("Coding") {}

/**
 * The teaching: the discipline AND the tools it grants, on the LAYER
 * — a different environment may make the same contract with different
 * prose over different tools.
 */
export const CodingGeneral = Coding.make`
  # Writing code in the repository checkout

  Your tools: ${Grep}, ${Glob}, ${ListDirectory}, ${ReadFile},
  ${EditFile}, ${ApplyPatch}, ${WriteFile}, ${Bash}, and
  ${ReadOutput}.

  ## The discipline the tools cannot carry alone

  - **Read before you edit** — the digest chain exists so you never
    change a version you have not seen.
  - **Verify with the test suite after your edits** — the suite, not
    your reading of the diff, is the oracle of done-ness.
  - **Write code that reads like the surrounding code** — match its
    idiom, naming, and comment density.

  ## Deeper craft

  When the work calls for it: ${ResourceEngineering} covers
  everything about building alchemy resources — the contract, the
  reconciler, and the disciplines that make providers reliable (its
  own deeper skills included).`;

export const CodingLocal = CodingGeneral.pipe(
  Layer.provide([ReadToolsLocal, RunToolsLocal, WriteToolsLocal]),
);

export const CodingWorker = CodingGeneral.pipe(
  Layer.provide([ReadToolsSandbox, RunToolsSandbox, WriteToolsSandbox]),
);
