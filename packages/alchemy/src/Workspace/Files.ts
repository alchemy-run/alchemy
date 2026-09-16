import { createHash } from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { Workspace } from "./Workspace.ts";

export interface FileSnapshot {
  readonly path: string;
  readonly fullPath: string;
  readonly content: string;
  readonly digest: string;
  readonly size: number;
  readonly bom: boolean;
}

const digestBytes = (bytes: Uint8Array): Effect.Effect<string> =>
  Effect.sync(() => createHash("sha256").update(bytes).digest("hex"));

const encodeText = (content: string, bom: boolean): Uint8Array => {
  const body = new TextEncoder().encode(content);
  if (!bom) return body;
  const bytes = new Uint8Array(body.length + 3);
  bytes.set([0xef, 0xbb, 0xbf]);
  bytes.set(body, 3);
  return bytes;
};

/**
 * Digest-guarded file physics over the {@link Workspace} — the shared
 * substrate of every file-mutation tool: UTF-8/BOM-aware reads that
 * refuse binaries, atomic writes (temp + rename) guarded by the digest
 * the caller last READ (a stale digest is a model-visible failure, not
 * a lost update), and digest-guarded deletes.
 */
export class WorkspaceFiles extends Context.Service<
  WorkspaceFiles,
  {
    readonly readText: (path: string) => Effect.Effect<FileSnapshot, string>;
    readonly digest: (path: string) => Effect.Effect<string, string>;
    readonly writeAtomic: (
      path: string,
      content: string,
      options:
        | { readonly mode: "create" }
        | {
            readonly mode: "overwrite";
            readonly expectedDigest: string;
            readonly bom?: boolean;
          },
    ) => Effect.Effect<{ readonly digest: string }, string>;
    readonly remove: (
      path: string,
      expectedDigest: string,
    ) => Effect.Effect<void, string>;
  }
>()("alchemy/Workspace/Files") {}

/** Safe, digest-aware file operations shared by all mutation tools. */
export const WorkspaceFilesLive = Layer.effect(
  WorkspaceFiles,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspace = yield* Workspace;

    const readText = (relative: string): Effect.Effect<FileSnapshot, string> =>
      Effect.gen(function* () {
        const fullPath = yield* workspace.resolveExisting(relative);
        const info = yield* fs
          .stat(fullPath)
          .pipe(Effect.mapError((error) => String(error)));
        if (info.type !== "File") {
          return yield* Effect.fail(`not a regular file: ${relative}`);
        }
        const bytes = yield* fs
          .readFile(fullPath)
          .pipe(Effect.mapError((error) => String(error)));
        if (bytes.includes(0)) {
          return yield* Effect.fail(
            `cannot read binary file: ${relative} (NUL byte detected)`,
          );
        }
        const bom =
          bytes.length >= 3 &&
          bytes[0] === 0xef &&
          bytes[1] === 0xbb &&
          bytes[2] === 0xbf;
        const content = yield* Effect.try({
          try: () =>
            new TextDecoder("utf-8", { fatal: true }).decode(
              bom ? bytes.slice(3) : bytes,
            ),
          catch: () => `cannot decode ${relative} as UTF-8 text`,
        });
        return {
          path: relative,
          fullPath,
          content,
          digest: yield* digestBytes(bytes),
          size: bytes.byteLength,
          bom,
        };
      });

    const writeAtomic = (
      relative: string,
      content: string,
      options:
        | { readonly mode: "create" }
        | {
            readonly mode: "overwrite";
            readonly expectedDigest: string;
            readonly bom?: boolean;
          },
    ) =>
      Effect.gen(function* () {
        const fullPath = yield* workspace.resolveForCreate(relative);
        const current = yield* fs.stat(fullPath).pipe(Effect.result);
        if (options.mode === "create") {
          if (Result.isSuccess(current)) {
            return yield* Effect.fail(
              `file already exists: ${relative} — read it first and use overwrite mode`,
            );
          }
        } else {
          if (Result.isFailure(current)) {
            return yield* Effect.fail(
              `cannot overwrite missing file: ${relative} — use create mode`,
            );
          }
          const snapshot = yield* readText(relative);
          if (snapshot.digest !== options.expectedDigest) {
            return yield* Effect.fail(
              `file changed since it was read: ${relative} — read it again and retry with the new digest`,
            );
          }
        }

        const directory = path.dirname(fullPath);
        yield* fs
          .makeDirectory(directory, { recursive: true })
          .pipe(Effect.mapError((error) => String(error)));
        const temp = yield* fs
          .makeTempFile({ directory, prefix: ".alchemy-write-" })
          .pipe(Effect.mapError((error) => String(error)));
        const bytes = encodeText(
          content,
          options.mode === "overwrite" && options.bom === true,
        );
        yield* fs.writeFile(temp, bytes).pipe(
          Effect.flatMap(() => fs.rename(temp, fullPath)),
          Effect.mapError((error) => String(error)),
          Effect.ensuring(
            fs
              .remove(temp, { force: true })
              .pipe(Effect.catch(() => Effect.void)),
          ),
        );
        return { digest: yield* digestBytes(bytes) };
      });

    const remove = (relative: string, expectedDigest: string) =>
      Effect.gen(function* () {
        const snapshot = yield* readText(relative);
        if (snapshot.digest !== expectedDigest) {
          return yield* Effect.fail(
            `file changed since it was read: ${relative} — read it again before deleting`,
          );
        }
        yield* fs
          .remove(snapshot.fullPath)
          .pipe(Effect.mapError((error) => String(error)));
      });

    return {
      readText,
      digest: (relative) =>
        Effect.map(readText(relative), (file) => file.digest),
      writeAtomic,
      remove,
    };
  }),
);
