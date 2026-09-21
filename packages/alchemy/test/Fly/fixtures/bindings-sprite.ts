import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Fly from "@/Fly";

export default class BindingsSprite extends Fly.Sprite<BindingsSprite>()(
  "BindingsSprite",
  { main: import.meta.url, port: 3000 },
  Effect.succeed({ fetch: Effect.succeed(HttpServerResponse.text("ok")) }),
) {}
