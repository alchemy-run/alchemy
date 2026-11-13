import { appendFileSync } from "node:fs";
/**
 * Applies one Export store mutant as Bun loads the source, chosen by
 * `EXPORT_MUTANT`. The file on disk is never changed. A mutant's text matches
 * with any whitespace between its tokens, so formatting the source does not
 * break it. The preload records in `EXPORT_MUTANT_MARKER` whether the mutant
 * applied (its text matches exactly once), so a mutant that no longer applies
 * cannot pass for one that was killed. The test runner captures console
 * output, hence a file.
 *
 * @module
 */
import { plugin } from "bun";
import { mutants } from "./mutants.ts";

/**
 * The mutant's text as a pattern: its characters in order, whitespace allowed
 * between any two (a formatter may break a line inside what the mutant wrote
 * as one token, e.g. `row).filter`).
 */
const patternOf = (text: string) =>
  new RegExp(
    Array.from(text.replace(/\s+/g, ""))
      .map((character) => character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s*"),
    "g",
  );

const id = process.env["EXPORT_MUTANT"];
const marker = process.env["EXPORT_MUTANT_MARKER"];
const mutant = mutants.find((candidate) => candidate.id === id);
const record = (line: string) => marker !== undefined && appendFileSync(marker, `${line}\n`);
if (id !== undefined && mutant === undefined) record(`unknown ${id}`);

if (mutant !== undefined) {
  plugin({
    name: "export-mutant",
    setup(build) {
      build.onLoad(
        { filter: new RegExp(`/domain/src/Export/${mutant.file.replace(".", "\\.")}$`) },
        async ({ path }) => {
          const source = await Bun.file(path).text();
          const pattern = patternOf(mutant.find);
          const occurrences = source.match(pattern)?.length ?? 0;
          record(
            occurrences === 1
              ? `applied ${mutant.id}`
              : `unapplied ${mutant.id}: found ${occurrences} times`,
          );
          return {
            contents: occurrences === 1 ? source.replace(pattern, () => mutant.replace) : source,
            loader: "ts",
          };
        },
      );
    },
  });
}
