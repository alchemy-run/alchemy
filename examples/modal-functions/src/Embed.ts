import * as Modal from "@alchemy.run/modal";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Inference } from "./Inference.ts";

/** A function other runtimes call: counts the words of its argument. */
export default class Embed extends Modal.Function<Embed>()(
  "Embed",
  { main: import.meta.url, app: Inference },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const call = yield* Modal.FunctionCall;
        const [text] = (call?.args ?? [""]) as [string];
        return yield* HttpServerResponse.json({ tokens: text.split(/\s+/).filter(Boolean).length });
      }).pipe(Effect.orDie),
    };
  }),
) {}
