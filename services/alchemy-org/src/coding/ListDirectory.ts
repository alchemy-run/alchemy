import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";

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

export class ListDirectory extends (AI.Tool<ListDirectory>(import.meta)(
  "listDirectory",
)`
List the immediate contents of ${pathParam}, including dotfiles,
sorted alphabetically with "/" after directories. This is shallow
orientation, not recursive discovery — use glob for that. Bound the
result with ${limit}.`) {}

/** Physics over the session {@link AI.Sandbox}. */
export const ListDirectoryLive = Layer.effect(
  ListDirectory,
  Effect.gen(function* () {
    const sandbox = yield* AI.Sandbox;
    return ((input: { path?: string; limit?: number }) =>
      Effect.gen(function* () {
        const entries = yield* sandbox.listFiles(input.path ?? ".");
        const rendered = entries.map((entry) =>
          entry.type === "directory" ? `${entry.name}/` : entry.name,
        );
        if (rendered.length === 0) return "(empty directory)";
        const max = input.limit ?? 500;
        return rendered.length > max
          ? `${rendered.slice(0, max).join("\n")}\n[${max} of ${rendered.length} entries shown — raise limit or use glob]`
          : rendered.join("\n");
      })) as never;
  }),
);
