import * as Modal from "@alchemy.run/modal";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Api from "./api-server.ts";
import Embed from "./embed-function.ts";
import { Services } from "./services.ts";

/**
 * A Modal Function that calls another Function and a Server through their
 * bindings, as its own container: no Modal token is bound into it.
 */
export default class Relay extends Modal.Function<Relay>()(
  "Relay",
  { main: import.meta.url, app: Services },
  Effect.gen(function* () {
    const embed = yield* Modal.InvokeFunction(Embed);
    const api = yield* Modal.FetchServer(Api);
    return {
      /** Calls `Embed.embed` and `Api.greet`, and reports whether a token was bound. */
      relay: Effect.fn(function* (text: string) {
        const token = yield* Config.option(Config.String("MODAL_TOKEN_ID"));
        return {
          embed: yield* embed.embed(text),
          greeting: yield* api.greet("relay"),
          tokenBound: token._tag === "Some",
        };
      }),
    };
  }).pipe(Effect.provide(Layer.mergeAll(Modal.InvokeFunctionHttp, Modal.FetchServerHttp))),
) {}
