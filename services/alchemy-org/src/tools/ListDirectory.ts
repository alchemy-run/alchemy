import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as S from "effect/Schema";
import { Workspace } from "alchemy/Workspace";

const pathParam = AI.Parameter("path", S.optionalKey(S.String))`
Workspace-relative directory to list (default: ".").`;

const limit = AI.Parameter(
  "limit",
  S.optionalKey(
    S.Int.pipe(
      S.check(S.isGreaterThanOrEqualTo(1), S.isLessThanOrEqualTo(2000)),
    ),
  ),
)`
Maximum entries to show (1-2000, default 500).`;

export class ListDirectory extends AI.Tool<ListDirectory>()("listDirectory")`
List the immediate contents of ${pathParam}, including dotfiles,
sorted alphabetically with "/" after directories. This is shallow
orientation, not recursive discovery — use glob for that. Bound the
result with ${limit}.` {}

export const ListDirectoryLocal = Layer.effect(
  ListDirectory,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspace = yield* Workspace;
    return ((input: { path?: string; limit?: number }) =>
      Effect.gen(function* () {
        const relative = input.path ?? ".";
        const full = yield* workspace.resolveExisting(relative);
        const info = yield* fs
          .stat(full)
          .pipe(Effect.mapError((error) => String(error)));
        if (info.type !== "Directory") {
          return yield* Effect.fail(`not a directory: ${relative}`);
        }
        const entries = yield* fs
          .readDirectory(full)
          .pipe(Effect.mapError((error) => String(error)));
        const rendered: string[] = [];
        for (const entry of entries) {
          const child = yield* fs
            .stat(path.join(full, entry))
            .pipe(Effect.mapError((error) => String(error)));
          rendered.push(child.type === "Directory" ? `${entry}/` : entry);
        }
        rendered.sort((a, b) =>
          a.localeCompare(b, undefined, { sensitivity: "base" }),
        );
        if (rendered.length === 0) return "(empty directory)";
        const max = input.limit ?? 500;
        return rendered.length > max
          ? `${rendered.slice(0, max).join("\n")}\n[${max} of ${rendered.length} entries shown — raise limit or use glob]`
          : rendered.join("\n");
      })) as never;
  }),
);
