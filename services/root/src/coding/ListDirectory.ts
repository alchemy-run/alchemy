import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";

const pathParam = AI.Thing("path", S.optionalKey(S.String))`
  Workspace-relative directory to list (default: ".").`;

const limit = AI.Thing(
  "limit",
  S.optionalKey(
    S.Int.pipe(
      S.check(S.isGreaterThanOrEqualTo(1), S.isLessThanOrEqualTo(2000)),
    ),
  ),
)`
  Maximum entries to show (1-2000, default 500).`;

const entries = AI.Thing("entries", S.Array(S.String))`
  The entry names, sorted alphabetically, "/" after directories —
  clipped to the limit.`;

const total = AI.Thing("total", S.Int)`
  How many entries the directory actually has.`;

export class ListDirectory extends (AI.Tool<ListDirectory>(import.meta)(
  "listDirectory",
)`
  List the immediate contents of ${pathParam}, including dotfiles —
  answers ${AI.out(entries, total)}. This is shallow orientation, not
  recursive discovery — use glob for that. Bound the result with
  ${limit}.`) {}

/** Physics over the session {@link AI.Sandbox}. */
export const ListDirectoryLive = Layer.effect(
  ListDirectory,
  Effect.gen(function* () {
    const sandbox = yield* AI.Sandbox;
    return Effect.fn(function* (input: { path?: string; limit?: number }) {
      const listed = yield* sandbox.listFiles(input.path ?? ".");
      const rendered = listed.map((entry) =>
        entry.type === "directory" ? `${entry.name}/` : entry.name,
      );
      const max = input.limit ?? 500;
      return {
        entries: rendered.slice(0, max),
        total: rendered.length,
      };
    }) as never;
  }),
);
