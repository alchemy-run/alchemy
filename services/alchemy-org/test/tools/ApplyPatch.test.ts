import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { applyPatch } from "../../src/patch/apply.ts";
import { parsePatch } from "../../src/patch/parser.ts";
import type { ApplyPatchInput } from "../../src/patch/types.ts";
import { Workspace, workspace } from "../../src/workspace.ts";

const digest = (bytes: Uint8Array) =>
  Effect.tryPromise(() =>
    crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
  ).pipe(
    Effect.map((value) =>
      Array.from(new Uint8Array(value), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
    ),
  );

const runInWorkspace = <A, E>(
  use: (root: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-org-apply-patch-",
      });
      return yield* use(root);
    }).pipe(
      Effect.provide(BunFileSystem.layer),
      Effect.provide(BunPath.layer),
      Effect.scoped,
    ),
  );

const execute = (root: string, input: ApplyPatchInput) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const current = yield* Workspace;
    return yield* applyPatch(input, fs, pathService, {
      root: yield* current.root,
      resolve: current.resolve,
    });
  }).pipe(Effect.provide(workspace(root)));

test("applies add, update, move, and delete after one preflight", () =>
  runInWorkspace((root) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(`${root}/edit.txt`, "one\ntwo\nthree\n");
      yield* fs.writeFileString(`${root}/move.txt`, "move me\n");
      yield* fs.writeFileString(`${root}/delete.txt`, "remove me\n");

      const expectedDigests = {
        "edit.txt": yield* fs
          .readFile(`${root}/edit.txt`)
          .pipe(Effect.flatMap(digest)),
        "move.txt": yield* fs
          .readFile(`${root}/move.txt`)
          .pipe(Effect.flatMap(digest)),
        "delete.txt": yield* fs
          .readFile(`${root}/delete.txt`)
          .pipe(Effect.flatMap(digest)),
      };
      const result = yield* execute(root, {
        expectedDigests,
        patchText: `*** Begin Patch
*** Add File: nested/added.txt
+new
+file
*** Update File: edit.txt
@@
 one
-two
+second
 three
*** Update File: move.txt
*** Move to: moved.txt
@@
-move me
+moved
*** Delete File: delete.txt
*** End Patch`,
      });

      expect(result).toBe(
        "Done!\nA nested/added.txt\nM edit.txt\nM move.txt -> moved.txt\nD delete.txt",
      );
      expect(yield* fs.readFileString(`${root}/nested/added.txt`)).toBe(
        "new\nfile",
      );
      expect(yield* fs.readFileString(`${root}/edit.txt`)).toBe(
        "one\nsecond\nthree\n",
      );
      expect(yield* fs.exists(`${root}/move.txt`)).toBe(false);
      expect(yield* fs.readFileString(`${root}/moved.txt`)).toBe("moved\n");
      expect(yield* fs.exists(`${root}/delete.txt`)).toBe(false);
    }),
  ));

test("matches rstrip, trim, Unicode punctuation, ordered headers, and EOF", () =>
  runInWorkspace((root) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const original =
        "\uFEFFsection one\r\n  const label = “first”;   \r\nsection two\r\n  const label = “second”;\r\nlast\u00A0line\r\n";
      yield* fs.writeFileString(`${root}/unicode.ts`, original);
      const expected = yield* fs
        .readFile(`${root}/unicode.ts`)
        .pipe(Effect.flatMap(digest));

      yield* execute(root, {
        expectedDigests: { "unicode.ts": expected },
        patchText: `*** Begin Patch
*** Update File: unicode.ts
@@ section one
-const label = "first";
+const label = "FIRST";
@@ section two
-const label = "second";
+const label = "SECOND";
@@
-last line
+done
*** End of File
*** End Patch`,
      });

      const updated = yield* fs.readFile(`${root}/unicode.ts`);
      expect(Array.from(updated.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
      expect(new TextDecoder().decode(updated.slice(3))).toBe(
        'section one\r\nconst label = "FIRST";\r\nsection two\r\nconst label = "SECOND";\r\ndone\r\n',
      );
    }),
  ));

test("rejects stale or missing digests without mutating any operation", () =>
  runInWorkspace((root) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(`${root}/source.txt`, "current\n");

      const input = {
        expectedDigests: { "source.txt": "0".repeat(64) },
        patchText: `*** Begin Patch
*** Add File: should-not-exist.txt
+created
*** Update File: source.txt
@@
-current
+changed
*** End Patch`,
      };
      const error = yield* execute(root, input).pipe(Effect.flip);
      expect(error).toContain("stale file source.txt");
      expect(yield* fs.readFileString(`${root}/source.txt`)).toBe("current\n");
      expect(yield* fs.exists(`${root}/should-not-exist.txt`)).toBe(false);

      const missing = yield* execute(root, {
        ...input,
        expectedDigests: {},
      }).pipe(Effect.flip);
      expect(missing).toContain("missing expected digest");
    }),
  ));

test("rejects unsafe paths and malformed hunks during parsing/preflight", () =>
  runInWorkspace((root) =>
    Effect.gen(function* () {
      const unsafe = yield* execute(root, {
        expectedDigests: {},
        patchText: `*** Begin Patch
*** Add File: ../escape.txt
+no
*** End Patch`,
      }).pipe(Effect.flip);
      expect(unsafe).toContain("must be relative");

      expect(() =>
        parsePatch(`*** Begin Patch
*** Update File: file.txt
@@
unprefixed
*** End Patch`),
      ).toThrow("hunk lines must start");
    }),
  ));
