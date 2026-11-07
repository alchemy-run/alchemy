import * as Modal from "@alchemy.run/modal";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import Embed from "./Embed.ts";
import { Inference } from "./Inference.ts";

/** A public server reporting how busy `Embed` is. */
export default class Status extends Modal.Server<Status>()(
  "Status",
  { main: import.meta.url, app: Inference, unauthenticated: true },
  Effect.gen(function* () {
    const embed = yield* Modal.ReadFunction(Embed);
    return {
      fetch: Effect.gen(function* () {
        const stats = yield* embed.stats();
        return yield* HttpServerResponse.json(stats);
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Modal.ReadFunctionHttp)),
) {}
