import * as DockerfileParser from "@alchemy.run/docker/DockerfileParser";
import { describe, expect, layer } from "@alchemy.run/test";
import { BunServices } from "@effect/platform-bun";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import cases from "./dockerfile-conformance/cases.json" with { type: "json" };

/**
 * Every Dockerfile under `dockerfile-conformance/cases/` must parse the way
 * BuildKit reads it. `expected.json` is BuildKit's answer, written by
 * `dockerfile-conformance/oracle` (`go run . ../cases`) from its parser and
 * instruction layer, with Docker's word processing applied but no variable
 * expanded. A case BuildKit rejects must fail with `DockerfileSyntaxError`.
 *
 * The `buildkit-*` cases are BuildKit's own parser corpus
 * (frontend/dockerfile/parser/testfiles, Apache-2.0); the rest cover
 * heredocs, directives, continuations, stages and each instruction's forms.
 */

interface Flag {
  readonly name: string;
  readonly value: string | null;
}
interface Heredoc {
  readonly name: string;
  readonly content: string;
  readonly stripTabs: boolean;
  readonly quoted: boolean;
}
interface Command {
  readonly form: "exec" | "shell";
  readonly argv?: ReadonlyArray<string>;
  readonly script?: string;
}
interface Instruction {
  readonly tag: string;
  readonly line: number;
  readonly flags: ReadonlyArray<Flag>;
  readonly command?: Command;
  readonly heredocs?: ReadonlyArray<Heredoc>;
  readonly sources?: ReadonlyArray<string>;
  readonly destination?: string;
  readonly vars?: ReadonlyArray<readonly [string, string | null]>;
  readonly value?: string;
}
interface Stage {
  readonly line: number;
  readonly image: string;
  readonly name: string | null;
  readonly flags: ReadonlyArray<Flag>;
  readonly instructions: ReadonlyArray<Instruction>;
}
type Expected =
  | { readonly ok: false; readonly error: string }
  | {
      readonly ok: true;
      readonly directives?: Readonly<Record<string, string>>;
      readonly globalArgs?: ReadonlyArray<Instruction>;
      readonly stages?: ReadonlyArray<Stage>;
    };

const flags = (fs: ReadonlyArray<DockerfileParser.Flag>): Flag[] =>
  fs.map((f) => ({ name: f.name, value: f.value ?? null }));

const command = (c: DockerfileParser.Command): Command =>
  c.form === "exec"
    ? c.argv.length === 0
      ? { form: "exec" }
      : { form: "exec", argv: [...c.argv] }
    : { form: "shell", script: c.script };

const heredocs = (hs: ReadonlyArray<DockerfileParser.Heredoc>) =>
  hs.length === 0 ? {} : { heredocs: hs.map((h) => ({ ...h })) };

/** Our parse, in the shape the oracle writes. */
const normalize = (parsed: DockerfileParser.ParsedDockerfile) => {
  const instruction = (i: DockerfileParser.Instruction): Instruction => {
    const base = { tag: i._tag, line: i.line, flags: flags(i.flags) };
    switch (i._tag) {
      case "RUN":
        return { ...base, command: command(i.command), ...heredocs(i.heredocs) };
      case "CMD":
      case "ENTRYPOINT":
      case "SHELL":
        return { ...base, command: command(i.command) };
      case "COPY":
      case "ADD":
        return {
          ...base,
          ...(i.sources.length === 0 ? {} : { sources: [...i.sources] }),
          destination: i.destination,
          ...heredocs(i.heredocs),
        };
      case "ENV":
        return i.vars.length === 0
          ? base
          : { ...base, vars: i.vars.map(([k, v]) => [k, v] as const) };
      case "ARG":
        return i.vars.length === 0
          ? base
          : { ...base, vars: i.vars.map(([k, v]) => [k, v ?? null] as const) };
      case "WORKDIR":
      case "USER":
      case "STOPSIGNAL":
        return { ...base, value: i.value };
      default:
        return base;
    }
  };
  return {
    ok: true as const,
    ...(Object.keys(parsed.directives).length === 0 ? {} : { directives: parsed.directives }),
    globalArgs: parsed.globalArgs.map(instruction),
    stages: parsed.stages.map((s) => ({
      line: s.line,
      image: s.image,
      name: s.name ?? null,
      flags: flags(s.flags),
      instructions: s.instructions.map(instruction),
    })),
  };
};

layer(BunServices.layer)("DockerfileParser conformance with BuildKit", (test) => {
  describe("cases", { tags: ["unit", "provider:docker"] }, () => {
    for (const name of cases) {
      test.effect(name, () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = path.join(import.meta.dirname, "dockerfile-conformance", "cases", name);
          const text = yield* fs.readFileString(path.join(dir, "Dockerfile"));
          const expected = JSON.parse(
            yield* fs.readFileString(path.join(dir, "expected.json")),
          ) as Expected;
          const result = yield* Effect.result(DockerfileParser.parse(text));
          if (!expected.ok) {
            expect(
              result._tag,
              `BuildKit rejects this Dockerfile (${expected.error}); the parser must too`,
            ).toBe("Failure");
            return;
          }
          if (result._tag === "Failure") {
            expect.fail(
              `BuildKit accepts this Dockerfile; the parser failed: ${result.failure.message}`,
            );
            return;
          }
          expect(normalize(result.success)).toEqual({
            ...expected,
            globalArgs: expected.globalArgs ?? [],
            stages: expected.stages ?? [],
          });
        }),
      );
    }
  });
});
