import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import { parsePatch } from "./parser.ts";
import type {
  ApplyPatchInput,
  Hunk,
  PatchOperation,
  UpdateFile,
} from "./types.ts";

interface Document {
  readonly text: string;
}

interface Snapshot {
  readonly fullPath: string;
  readonly document: Document | undefined;
  readonly digest: string | undefined;
}

interface PlannedPatch {
  readonly snapshots: ReadonlyMap<string, Snapshot>;
  readonly final: ReadonlyMap<string, Document | undefined>;
  readonly summary: ReadonlyArray<string>;
}

interface WorkspaceAccess {
  readonly root: string;
  readonly resolve: (relative: string) => Effect.Effect<string, string>;
}

type MatchPass = "exact" | "rstrip" | "trim" | "unicode";

const unicodeComparable = (value: string): string =>
  value
    .normalize("NFC")
    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, " ")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .trim();

const comparable = (value: string, pass: MatchPass): string => {
  switch (pass) {
    case "exact":
      return value;
    case "rstrip":
      return value.trimEnd();
    case "trim":
      return value.trim();
    case "unicode":
      return unicodeComparable(value);
  }
};

const passes: ReadonlyArray<MatchPass> = ["exact", "rstrip", "trim", "unicode"];

const findSequence = (
  lines: ReadonlyArray<string>,
  needle: ReadonlyArray<string>,
  start: number,
  eof: boolean,
): { index: number; pass: MatchPass } | undefined => {
  if (needle.length === 0) {
    return { index: eof ? lines.length : start, pass: "exact" };
  }
  for (const pass of passes) {
    const first = eof ? lines.length - needle.length : start;
    const last = eof ? first : lines.length - needle.length;
    for (let index = first; index <= last; index++) {
      if (index < start || index < 0) continue;
      if (
        needle.every(
          (line, offset) =>
            comparable(lines[index + offset]!, pass) === comparable(line, pass),
        )
      ) {
        return { index, pass };
      }
    }
  }
  return undefined;
};

const hunkExcerpt = (hunk: Hunk): string => {
  const old = hunk.lines
    .filter((line) => line.kind !== "add")
    .map((line) => line.text);
  return old.slice(0, 3).join("\n");
};

const applyUpdate = (operation: UpdateFile, source: string): string => {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
  let normalized = source.slice(bom.length).replace(/\r\n?/g, "\n");
  const finalNewline = normalized.endsWith("\n");
  if (finalNewline) normalized = normalized.slice(0, -1);
  const lines = normalized === "" ? [] : normalized.split("\n");
  let orderedCursor = 0;

  for (const hunk of operation.hunks) {
    if (hunk.header !== undefined) {
      const header = findSequence(lines, [hunk.header], orderedCursor, false);
      if (header === undefined) {
        throw new Error(
          `could not find hunk header ${JSON.stringify(hunk.header)} in ${operation.path} ` +
            `(patch line ${hunk.patchLine})`,
        );
      }
      orderedCursor = header.index + 1;
    }

    const oldLines = hunk.lines
      .filter((line) => line.kind !== "add")
      .map((line) => line.text);
    const newLines = hunk.lines
      .filter((line) => line.kind !== "delete")
      .map((line) => line.text);
    const match = findSequence(lines, oldLines, orderedCursor, hunk.endOfFile);
    if (match === undefined) {
      const anchor = hunk.endOfFile ? " at end of file" : "";
      const excerpt = hunkExcerpt(hunk);
      throw new Error(
        `could not apply hunk to ${operation.path}${anchor} (patch line ${hunk.patchLine})` +
          (excerpt === "" ? "" : `\nExpected context:\n${excerpt}`),
      );
    }
    lines.splice(match.index, oldLines.length, ...newLines);
    orderedCursor = match.index + newLines.length;
  }

  return (
    bom +
    lines.join(newline) +
    (finalNewline && lines.length > 0 ? newline : "")
  );
};

const sha256 = (bytes: Uint8Array): Effect.Effect<string, string> =>
  Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
    catch: (error) => `failed to compute SHA-256 digest: ${String(error)}`,
  }).pipe(
    Effect.map((digest) =>
      Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
    ),
  );

const normalizeDigest = (digest: string): string =>
  digest.toLowerCase().replace(/^sha256:/, "");

const decodeText = (bytes: Uint8Array): string => {
  const hasBom =
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf;
  return (
    (hasBom ? "\uFEFF" : "") +
    new TextDecoder("utf-8", { fatal: true }).decode(
      hasBom ? bytes.subarray(3) : bytes,
    )
  );
};

const validateDigest = (path: string, digest: string): string => {
  const normalized = normalizeDigest(digest);
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(
      `expectedDigests[${JSON.stringify(path)}] must be a SHA-256 hex digest`,
    );
  }
  return normalized;
};

const operationPaths = (
  operations: ReadonlyArray<PatchOperation>,
): ReadonlyArray<string> =>
  operations.flatMap((operation) =>
    operation._tag === "UpdateFile" && operation.moveTo !== undefined
      ? [operation.path, operation.moveTo]
      : [operation.path],
  );

const preflight = (
  input: ApplyPatchInput,
  fs: FileSystem.FileSystem,
  pathService: Path.Path,
  workspace: WorkspaceAccess,
): Effect.Effect<PlannedPatch, string> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => parsePatch(input.patchText),
      catch: (error) => String(error),
    });

    const validatePath = (candidate: string): string => {
      if (
        candidate.length === 0 ||
        candidate.includes("\0") ||
        pathService.isAbsolute(candidate) ||
        /^[A-Za-z]:[\\/]/.test(candidate) ||
        candidate.startsWith("\\") ||
        candidate.split(/[\\/]/).includes("..")
      ) {
        throw new Error(
          `patch paths must be relative and stay inside the workspace: ${JSON.stringify(candidate)}`,
        );
      }
      const normalized = pathService.normalize(candidate);
      if (normalized === "." || normalized !== candidate) {
        throw new Error(
          `patch path must be normalized (use ${JSON.stringify(normalized)}): ${JSON.stringify(candidate)}`,
        );
      }
      return normalized;
    };

    yield* Effect.try({
      try: () => {
        for (const candidate of operationPaths(parsed.operations)) {
          validatePath(candidate);
        }
        for (const candidate of Object.keys(input.expectedDigests)) {
          validatePath(candidate);
          validateDigest(candidate, input.expectedDigests[candidate]!);
        }
      },
      catch: (error) => String(error),
    });

    const snapshots = new Map<string, Snapshot>();
    const virtual = new Map<string, Document | undefined>();
    const diskOrigin = new Set<string>();

    const load = (relative: string) =>
      Effect.gen(function* () {
        if (virtual.has(relative)) return virtual.get(relative);
        const fullPath = yield* workspace.resolve(relative);
        const exists = yield* fs
          .exists(fullPath)
          .pipe(Effect.mapError((error) => String(error)));
        if (!exists) {
          snapshots.set(relative, {
            fullPath,
            document: undefined,
            digest: undefined,
          });
          virtual.set(relative, undefined);
          return undefined;
        }
        const bytes = yield* fs
          .readFile(fullPath)
          .pipe(Effect.mapError((error) => String(error)));
        const text = yield* Effect.try({
          try: () => decodeText(bytes),
          catch: () =>
            `cannot patch ${relative}: existing file is not valid UTF-8 text`,
        });
        const digest = yield* sha256(bytes);
        const document = { text };
        snapshots.set(relative, { fullPath, document, digest });
        virtual.set(relative, document);
        diskOrigin.add(relative);
        return document;
      });

    const verifySource = (relative: string) =>
      Effect.gen(function* () {
        const document = yield* load(relative);
        if (document === undefined) {
          return yield* Effect.fail(
            `cannot patch ${relative}: file does not exist`,
          );
        }
        if (diskOrigin.has(relative)) {
          const expected = input.expectedDigests[relative];
          if (expected === undefined) {
            return yield* Effect.fail(
              `missing expected digest for existing source file ${relative}; re-read it before applying the patch`,
            );
          }
          const actual = snapshots.get(relative)!.digest!;
          if (normalizeDigest(expected) !== actual) {
            return yield* Effect.fail(
              `stale file ${relative}: expected SHA-256 ${normalizeDigest(expected)}, ` +
                `but found ${actual}; re-read the file and rebuild the patch`,
            );
          }
        }
        return document;
      });

    const touched = new Set<string>();
    const summary: string[] = [];
    for (const operation of parsed.operations) {
      if (operation._tag === "AddFile") {
        if ((yield* load(operation.path)) !== undefined) {
          return yield* Effect.fail(
            `cannot add ${operation.path}: file already exists`,
          );
        }
        virtual.set(operation.path, { text: operation.content });
        touched.add(operation.path);
        summary.push(`A ${operation.path}`);
      } else if (operation._tag === "DeleteFile") {
        yield* verifySource(operation.path);
        virtual.set(operation.path, undefined);
        touched.add(operation.path);
        summary.push(`D ${operation.path}`);
      } else {
        const source = yield* verifySource(operation.path);
        const updated = yield* Effect.try({
          try: () => applyUpdate(operation, source.text),
          catch: (error) => String(error),
        });
        const destination = operation.moveTo ?? operation.path;
        if (destination !== operation.path) {
          if ((yield* load(destination)) !== undefined) {
            return yield* Effect.fail(
              `cannot move ${operation.path} to ${destination}: destination already exists`,
            );
          }
          virtual.set(operation.path, undefined);
          touched.add(operation.path);
          summary.push(`M ${operation.path} -> ${destination}`);
        } else {
          summary.push(`M ${operation.path}`);
        }
        virtual.set(destination, { text: updated });
        touched.add(destination);
      }
    }

    const final = new Map<string, Document | undefined>();
    for (const relative of touched) {
      final.set(relative, virtual.get(relative));
      if (!snapshots.has(relative)) yield* load(relative);
    }
    return { snapshots, final, summary };
  });

const commit = (
  plan: PlannedPatch,
  fs: FileSystem.FileSystem,
  pathService: Path.Path,
  workspace: WorkspaceAccess,
): Effect.Effect<void, string> =>
  Effect.gen(function* () {
    const stage = yield* fs
      .makeTempDirectory({
        directory: workspace.root,
        prefix: ".alchemy-apply-patch-",
      })
      .pipe(Effect.mapError((error) => String(error)));
    const entries = Array.from(plan.final.entries());
    let mutationStarted = false;

    const rollback = Effect.gen(function* () {
      if (!mutationStarted) return;
      for (let index = 0; index < entries.length; index++) {
        const [relative] = entries[index]!;
        const snapshot = plan.snapshots.get(relative)!;
        yield* fs
          .remove(snapshot.fullPath, { force: true })
          .pipe(Effect.ignore);
        if (snapshot.document !== undefined) {
          yield* fs
            .makeDirectory(pathService.dirname(snapshot.fullPath), {
              recursive: true,
            })
            .pipe(Effect.ignore);
          yield* fs
            .copyFile(
              pathService.join(stage, `backup-${index}`),
              snapshot.fullPath,
            )
            .pipe(Effect.ignore);
        }
      }
    });

    const staged = Effect.gen(function* () {
      for (let index = 0; index < entries.length; index++) {
        const [relative, document] = entries[index]!;
        const snapshot = plan.snapshots.get(relative)!;
        if (snapshot.document !== undefined) {
          yield* fs
            .copyFile(
              snapshot.fullPath,
              pathService.join(stage, `backup-${index}`),
            )
            .pipe(Effect.mapError((error) => String(error)));
        }
        if (document !== undefined) {
          yield* fs
            .writeFileString(
              pathService.join(stage, `output-${index}`),
              document.text,
            )
            .pipe(Effect.mapError((error) => String(error)));
        }
      }

      // Close the read-to-write race as far as portable filesystem APIs allow.
      for (const [relative] of entries) {
        const snapshot = plan.snapshots.get(relative)!;
        const exists = yield* fs
          .exists(snapshot.fullPath)
          .pipe(Effect.mapError((error) => String(error)));
        if ((snapshot.document !== undefined) !== exists) {
          return yield* Effect.fail(
            `workspace changed during apply: ${relative}; no files were mutated`,
          );
        }
        if (exists) {
          const current = yield* fs
            .readFile(snapshot.fullPath)
            .pipe(Effect.mapError((error) => String(error)));
          if ((yield* sha256(current)) !== snapshot.digest) {
            return yield* Effect.fail(
              `workspace changed during apply: ${relative}; no files were mutated`,
            );
          }
        }
      }

      mutationStarted = true;
      for (let index = 0; index < entries.length; index++) {
        const [, document] = entries[index]!;
        const snapshot = plan.snapshots.get(entries[index]![0])!;
        yield* fs
          .remove(snapshot.fullPath, { force: true })
          .pipe(Effect.mapError((error) => String(error)));
        if (document !== undefined) {
          yield* fs
            .makeDirectory(pathService.dirname(snapshot.fullPath), {
              recursive: true,
            })
            .pipe(Effect.mapError((error) => String(error)));
          yield* fs
            .rename(
              pathService.join(stage, `output-${index}`),
              snapshot.fullPath,
            )
            .pipe(Effect.mapError((error) => String(error)));
        }
      }
    });

    yield* staged.pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* rollback;
          return yield* Effect.fail(
            mutationStarted
              ? `${error}\nApply failed during commit; rollback was attempted on a best-effort basis. ` +
                  `Filesystem changes are not transactionally guaranteed.`
              : `${error}\nApply failed while staging; workspace files were not mutated.`,
          );
        }),
      ),
      Effect.ensuring(
        fs.remove(stage, { recursive: true, force: true }).pipe(Effect.ignore),
      ),
    );
  });

/** Parse, preflight, stage, and commit one patch against a workspace. */
export const applyPatch = (
  input: ApplyPatchInput,
  fs: FileSystem.FileSystem,
  pathService: Path.Path,
  workspace: WorkspaceAccess,
): Effect.Effect<string, string> =>
  Effect.gen(function* () {
    const plan = yield* preflight(input, fs, pathService, workspace);
    yield* commit(plan, fs, pathService, workspace);
    return `Done!\n${plan.summary.join("\n")}`;
  });
