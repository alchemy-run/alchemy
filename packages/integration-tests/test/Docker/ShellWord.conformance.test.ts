import * as ShellWord from "@alchemy.run/docker/ShellWord";
import { describe, expect, it } from "@alchemy.run/test";
import * as Result from "effect/Result";
import cases from "./dockerfile-conformance/words/expected.json" with { type: "json" };

/**
 * Docker's word processing, checked against BuildKit's shell lexer
 * (`frontend/dockerfile/shell`) with no environment. The inputs are
 * BuildKit's own lexer tables (`envVarTest`, `wordsTest`) plus substitution
 * and escape forms they leave out; `words/expected.json` is written by
 * `dockerfile-conformance/oracle`.
 */

interface Expected {
  readonly ok: boolean;
  readonly word?: string;
  readonly words?: ReadonlyArray<string>;
}

const modes = {
  word: (input: string) => ShellWord.processWord(input, { escape: "\\" }),
  wordBacktick: (input: string) => ShellWord.processWord(input, { escape: "`" }),
  words: (input: string) => ShellWord.processWords(input, { escape: "\\" }),
  wordsRawQuotes: (input: string) =>
    ShellWord.processWords(input, { escape: "\\", rawQuotes: true }),
  wordsRaw: (input: string) =>
    ShellWord.processWords(input, { escape: "\\", rawQuotes: true, rawEscapes: true }),
} as const;

const actual = (result: Result.Result<string | string[], ShellWord.ShellWordError>) =>
  Result.isFailure(result)
    ? { ok: false }
    : typeof result.success === "string"
      ? { ok: true, word: result.success }
      : { ok: true, words: result.success };

describe("ShellWord conformance with BuildKit", { tags: ["unit", "provider:docker"] }, () => {
  for (const entry of cases as ReadonlyArray<Record<string, unknown> & { input: string }>) {
    it(JSON.stringify(entry.input), () => {
      for (const [mode, run] of Object.entries(modes)) {
        const expected = entry[mode] as Expected;
        const normalized =
          expected.ok && mode.startsWith("words")
            ? { ok: true, words: expected.words ?? [] }
            : expected;
        expect(actual(run(entry.input)), mode).toEqual(normalized);
      }
    });
  }
});
