import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import { sha256Hex } from "../sandbox/Digest.ts";
import { path } from "./ReadFile.ts";

const content = AI.Parameter("content", S.String)`
The COMPLETE new contents of the file — never a patch or a fragment,
the whole file as it should be on disk.`;

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

/** Physics over the session {@link AI.Sandbox}. */
export const WriteFileLive = Layer.effect(
  WriteFile,
  Effect.gen(function* () {
    const sandbox = yield* AI.Sandbox;
    return ((input: {
      path: string;
      content: string;
      mode: "create" | "overwrite";
      expectedDigest?: string;
    }) =>
      Effect.gen(function* () {
        const present = yield* sandbox.exists(input.path);
        if (input.mode === "create") {
          if (present) {
            return yield* Effect.fail(
              `file already exists: ${input.path} — read it first and use overwrite mode`,
            );
          }
        } else {
          if (input.expectedDigest === undefined) {
            return yield* Effect.fail(
              "expectedDigest is required in overwrite mode — read the file first",
            );
          }
          if (!present) {
            return yield* Effect.fail(
              `cannot overwrite missing file: ${input.path} — use create mode`,
            );
          }
          const current = yield* sandbox.readFile(input.path);
          const digest = yield* sha256Hex(current);
          if (digest !== input.expectedDigest) {
            return yield* Effect.fail(
              `file changed since it was read: ${input.path} — read it again and retry with the new digest`,
            );
          }
        }
        yield* sandbox.writeFile(input.path, input.content);
        const digest = yield* sha256Hex(input.content);
        return `wrote ${input.path} (${new TextEncoder().encode(input.content).byteLength} bytes)\n[SHA-256: ${digest}]`;
      })) as never;
  }),
);
