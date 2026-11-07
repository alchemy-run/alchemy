import * as Modal from "@alchemy.run/modal";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Services } from "./services.ts";

/** The `fail` method's typed failure. */
export class EmbedRejected extends Data.TaggedError("EmbedRejected")<{
  readonly reason: string;
}> {}

/** An Effect function other runtimes call through its RPC methods. */
export default class Embed extends Modal.Function<Embed>()(
  "Embed",
  { main: import.meta.url, app: Services, env: { MODEL: "words" } },
  Effect.gen(function* () {
    return {
      /** Counts the words of `text`. */
      embed: Effect.fn(function* (text: string) {
        return {
          model: yield* Config.String("MODEL").pipe(Effect.orDie),
          tokens: text.split(/\s+/).filter(Boolean).length,
        };
      }),
      /** Always fails with a typed error. */
      fail: (reason: string) => Effect.fail(new EmbedRejected({ reason })),
      /** The numbers 1 to `n`, as a stream. */
      count: (n: number) => Stream.range(1, n),
    };
  }),
) {}
