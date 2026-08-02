import * as Effect from "effect/Effect";

export interface ZipFile {
  path: string;
  content: string | Uint8Array<ArrayBufferLike>;
  /**
   * Unix file mode to record in the archive entry (e.g. `0o755` to keep an
   * executable bit). Omit to use the archiver's default.
   */
  mode?: number;
}

export const zipCode = Effect.fn(function* (
  content: string | Uint8Array<ArrayBufferLike>,
  files?: ReadonlyArray<ZipFile>,
) {
  // Create a zip buffer in memory
  const zip = new (yield* Effect.promise(() => import("jszip"))).default();
  const date = new Date("1980-01-01T00:00:00.000Z");
  zip.file("index.mjs", content, { date });
  for (const file of files ?? []) {
    zip.file(file.path, file.content, { date });
  }

  return yield* Effect.promise(() =>
    zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      platform: "UNIX",
    }),
  );
});

/**
 * Package `files` into a deterministic zip archive: entries are sorted by
 * path and stamped with a fixed timestamp so identical inputs always produce
 * identical bytes.
 */
export const zipFiles = Effect.fn(function* (files: ReadonlyArray<ZipFile>) {
  // Create a zip buffer in memory
  const zip = new (yield* Effect.promise(() => import("jszip"))).default();
  const date = new Date("1980-01-01T00:00:00.000Z");
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    zip.file(file.path, file.content, {
      date,
      unixPermissions: file.mode,
    });
  }
  // Nested paths make JSZip synthesize the intermediate folder entries, and
  // those are stamped with `new Date()` rather than the per-file `date`
  // above. Left alone, two archives built from identical bytes seconds apart
  // differ — which reads downstream as a content change.
  yield* Effect.sync(() => {
    for (const entry of Object.values(zip.files)) {
      entry.date = date;
    }
  });

  return yield* Effect.promise(() =>
    zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      platform: "UNIX",
    }),
  );
});
