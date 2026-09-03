/**
 * The self-referential lock: `AGENTS.md` (what a human coding agent
 * reads) IS the rendering of `OrgGuidance` and the domain skills it
 * names (what the org's own agents activate). Editing one without
 * regenerating the other fails here — `bun scripts/agents-md.ts`
 * brings them back together. And the doctrine stays PLUGGABLE: every
 * guidance skill is prose over sources and skills — none grants a
 * tool, so any charter can hold any of them — except `Verification`,
 * which grants read-and-run tools only (a judge, never an author).
 */
import { BunServices } from "@effect/platform-bun";
import * as AI from "alchemy/AI";
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { DistillationGeneral } from "../src/process/Distillation.ts";
import { AwsEmulationGeneral } from "../src/process/AwsEmulation.ts";
import { CloudflareEmulationGeneral } from "../src/process/CloudflareEmulation.ts";
import { ProviderEngineeringGeneral } from "../src/process/ProviderEngineering.ts";
import { VerificationGeneral } from "../src/process/Verification.ts";
import { Bash } from "../src/coding/Bash.ts";
import { CharterGuidanceGeneral } from "../src/CharterGuidance.ts";
import { ToolGuidanceGeneral } from "../src/coding/ToolGuidance.ts";
import { ProposalsGuidanceGeneral } from "../src/github/ProposalsGuidance.ts";
import { OrgGuidanceGeneral, renderAgentsMd } from "../src/OrgGuidance.ts";
import { SandboxGuidanceGeneral } from "../src/sandbox/SandboxGuidance.ts";

const run = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) => Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));

const names = (refs: ReadonlyArray<unknown>) =>
  refs
    .filter((ref) => !AI.isSource(ref))
    .map((ref) => (ref as { "~alchemy/Name": string })["~alchemy/Name"]);

test("AGENTS.md is the rendered org doctrine", async () => {
  const actual = await run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      return yield* fs.readFileString(
        path.resolve(import.meta.dirname, "..", "AGENTS.md"),
      );
    }),
  );
  expect(actual).toBe(await run(renderAgentsMd));
});

test("the domain guidance skills are prose — they splice sources and skills, never a tool", () => {
  for (const teaching of [
    ToolGuidanceGeneral,
    CharterGuidanceGeneral,
    SandboxGuidanceGeneral,
    ProposalsGuidanceGeneral,
    ProviderEngineeringGeneral,
    DistillationGeneral,
    AwsEmulationGeneral,
    CloudflareEmulationGeneral,
  ]) {
    expect(names(teaching.refs)).toEqual([]);
  }
  // the entry skill names exactly the domain skills — the skill graph
  expect(new Set(names(OrgGuidanceGeneral.refs))).toEqual(
    new Set([
      "ToolGuidance",
      "CharterGuidance",
      "SandboxGuidance",
      "ProposalsGuidance",
    ]),
  );
});

test("Verification grants read-and-run tools only — both charters can hold it", () => {
  expect(new Set(names(VerificationGeneral.refs))).toEqual(
    new Set([
      "bash",
      "glob",
      "grep",
      "listDirectory",
      "readFile",
      "readOutput",
    ]),
  );
});

test("a term's source renders as its path relative to the package", async () => {
  expect(Bash.source).toBeDefined();
  const path = await run(AI.resolveSource(Bash.source!));
  expect(path).toBe("src/coding/Bash.ts");
  await run(AI.resolveSources(ToolGuidanceGeneral.refs));
  expect(AI.render(ToolGuidanceGeneral)).toContain("`src/coding/Bash.ts`");
});
