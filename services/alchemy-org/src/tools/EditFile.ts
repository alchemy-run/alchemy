import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import { WorkspaceFiles } from "alchemy/Workspace";
import { path } from "../Vocabulary.ts";

const edits = AI.Parameter(
  "edits",
  S.Array(
    S.Struct({
      oldString: S.String,
      newString: S.String,
      replaceAll: S.optionalKey(S.Boolean),
    }),
  ).pipe(S.check(S.isMinLength(1))),
)`
One or more non-overlapping replacements, all matched against the
ORIGINAL file. oldString must match byte-for-byte (including
indentation), be unique unless replaceAll is true, and must not
include readFile's "N: " prefix. Merge nearby changes into one edit;
do not pad distant edits with large unchanged regions.`;

const expectedDigest = AI.Parameter("expectedDigest", S.String)`
The SHA-256 digest returned by readFile for this exact file version.`;

export class EditFile extends AI.Tool<EditFile>()("editFile")`
Apply atomic exact-string ${edits} to the existing file at ${path}.
The entire call is preflighted before anything is written; any
missing, ambiguous, or overlapping edit leaves the file unchanged.
Pass ${expectedDigest} to prove the file has not changed since you
read it. Prefer this over writeFile for existing files.` {}

/** Local physics over the {@link Workspace} checkout. */
export const EditFileLocal = Layer.effect(
  EditFile,
  Effect.gen(function* () {
    const files = yield* WorkspaceFiles;
    return ((input: {
      path: string;
      edits: ReadonlyArray<{
        oldString: string;
        newString: string;
        replaceAll?: boolean;
      }>;
      expectedDigest: string;
    }) =>
      Effect.gen(function* () {
        const snapshot = yield* files.readText(input.path);
        if (snapshot.digest !== input.expectedDigest) {
          return yield* Effect.fail(
            `file changed since it was read: ${input.path} — read it again and retry with the new digest`,
          );
        }

        interface Replacement {
          readonly start: number;
          readonly end: number;
          readonly text: string;
        }
        const replacements: Replacement[] = [];
        for (const edit of input.edits) {
          if (edit.oldString.length === 0) {
            return yield* Effect.fail(
              "oldString must not be empty — use writeFile to create a new file",
            );
          }
          if (edit.oldString === edit.newString) {
            return yield* Effect.fail(
              "oldString and newString are identical — no change to apply",
            );
          }
          const starts: number[] = [];
          let cursor = 0;
          while (true) {
            const found = snapshot.content.indexOf(edit.oldString, cursor);
            if (found === -1) break;
            starts.push(found);
            cursor = found + edit.oldString.length;
          }
          if (starts.length === 0) {
            return yield* Effect.fail(
              `oldString was not found in ${input.path} — re-read the file ` +
                `and copy the exact text without the "N: " line-number prefix`,
            );
          }
          if (starts.length > 1 && edit.replaceAll !== true) {
            return yield* Effect.fail(
              `oldString matches ${starts.length} locations in ${input.path} — ` +
                `include more surrounding context or set replaceAll`,
            );
          }
          for (const start of edit.replaceAll === true
            ? starts
            : [starts[0]!]) {
            replacements.push({
              start,
              end: start + edit.oldString.length,
              text: edit.newString,
            });
          }
        }

        replacements.sort((a, b) => a.start - b.start);
        for (let index = 1; index < replacements.length; index++) {
          if (replacements[index]!.start < replacements[index - 1]!.end) {
            return yield* Effect.fail(
              `edits overlap in ${input.path} — merge nearby changes into one edit`,
            );
          }
        }

        let updated = snapshot.content;
        for (const replacement of [...replacements].reverse()) {
          updated =
            updated.slice(0, replacement.start) +
            replacement.text +
            updated.slice(replacement.end);
        }
        const result = yield* files.writeAtomic(input.path, updated, {
          mode: "overwrite",
          expectedDigest: input.expectedDigest,
          bom: snapshot.bom,
        });
        return `edited ${input.path}: replaced ${replacements.length} block(s)\n[SHA-256: ${result.digest}]`;
      })) as never;
  }),
);
