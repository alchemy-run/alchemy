import * as Modal from "@alchemy.run/modal";
import * as Effect from "effect/Effect";
import { Inference } from "./Inference.ts";

/** A function other runtimes call through its `embed` method. */
export default class Embed extends Modal.Function<Embed>()(
  "Embed",
  { main: import.meta.url, app: Inference },
  Effect.gen(function* () {
    return {
      /** Counts the words of `text`. */
      embed: Effect.fn(function* (text: string) {
        return { tokens: text.split(/\s+/).filter(Boolean).length };
      }),
    };
  }),
) {}
