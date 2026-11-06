import * as Modal from "@alchemy.run/modal";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Services } from "./services.ts";

/** An Effect function other runtimes call: counts the words of its argument. */
export default class Embed extends Modal.Function<Embed>()(
  "Embed",
  { main: import.meta.url, app: Services, env: { MODEL: "words" } },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const call = yield* Modal.FunctionCall;
        if (call === undefined) return HttpServerResponse.text("not a call", { status: 404 });
        const [text] = call.args as [string];
        if (text === "fail") return HttpServerResponse.text("asked to fail", { status: 500 });
        return yield* HttpServerResponse.json({
          model: yield* Config.String("MODEL"),
          tokens: text.split(/\s+/).filter(Boolean).length,
          kwargs: call.kwargs,
        });
      }).pipe(Effect.orDie),
    };
  }),
) {}
