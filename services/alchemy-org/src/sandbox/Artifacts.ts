import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { truncateHead } from "./Output.ts";

export interface Artifact {
  readonly id: string;
  readonly append: (chunk: string) => Effect.Effect<void, string>;
}

export class Artifacts extends Context.Service<
  Artifacts,
  {
    readonly create: (label: string) => Effect.Effect<Artifact, string>;
    readonly read: (id: string) => Effect.Effect<string, string>;
    readonly size: (id: string) => Effect.Effect<number, string>;
  }
>()("alchemy-org/Artifacts") {}

/**
 * Page one artifact back for the model — the ONE reading convention
 * shared by every door to the store (the `readOutput` tool and the
 * spill net's self-provided redemption): 1-indexed `offset`, up to
 * `limit` lines (default 2000), each page capped at 50KB, with a
 * continuation line when more remains.
 */
export const pageArtifact = (
  artifacts: Artifacts["Service"],
  input: { outputId: string; offset?: number; limit?: number },
): Effect.Effect<string, string> =>
  Effect.gen(function* () {
    const text = yield* artifacts.read(input.outputId);
    const lines = text.split("\n");
    const start = input.offset ?? 1;
    if (start > lines.length) {
      return yield* Effect.fail(
        `offset ${start} is past the end of ${input.outputId} (${lines.length} lines)`,
      );
    }
    const max = input.limit ?? 2000;
    const page = lines.slice(start - 1, start - 1 + max).join("\n");
    const truncated = truncateHead(page, {
      maxLines: max,
      maxBytes: 50_000,
    });
    const end = start + truncated.shownLines - 1;
    return end < lines.length
      ? `${truncated.text}\n[Showing lines ${start}-${end} of ${lines.length}. Use offset=${end + 1} to continue.]`
      : truncated.text;
  });

