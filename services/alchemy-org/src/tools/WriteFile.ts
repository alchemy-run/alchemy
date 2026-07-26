import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import { WorkspaceFiles } from "alchemy/Workspace";
import { content, path } from "../Vocabulary.ts";

const mode = AI.Parameter("mode", S.Literals(["create", "overwrite"]))`
"create" requires the path not to exist. "overwrite" requires an
existing file and its expectedDigest from readFile.`;

const expectedDigest = AI.Parameter("expectedDigest", S.optionalKey(S.String))`
Required in overwrite mode: the SHA-256 digest returned by readFile
for the exact version being replaced.`;

export class WriteFile extends AI.Tool<WriteFile>()("writeFile")`
Write complete ${content} to ${path} using ${mode}, creating parent
directories only after all preconditions pass. Existing files may
only be replaced with ${expectedDigest}. Use create for new files
and overwrite only for complete rewrites — prefer editFile for
targeted changes.` {}

/** Local physics over the {@link Workspace} checkout. */
export const WriteFileLocal = Layer.effect(
  WriteFile,
  Effect.gen(function* () {
    const files = yield* WorkspaceFiles;
    return ((input: {
      path: string;
      content: string;
      mode: "create" | "overwrite";
      expectedDigest?: string;
    }) =>
      Effect.gen(function* () {
        if (input.mode === "overwrite" && input.expectedDigest === undefined) {
          return yield* Effect.fail(
            "expectedDigest is required in overwrite mode — read the file first",
          );
        }
        const result = yield* files.writeAtomic(
          input.path,
          input.content,
          input.mode === "create"
            ? { mode: "create" }
            : {
                mode: "overwrite",
                expectedDigest: input.expectedDigest!,
              },
        );
        return `wrote ${input.path} (${new TextEncoder().encode(input.content).byteLength} bytes)\n[SHA-256: ${result.digest}]`;
      })) as never;
  }),
);
