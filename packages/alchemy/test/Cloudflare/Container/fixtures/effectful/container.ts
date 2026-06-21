import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Storage } from "./storage.ts";

export class MyContainer extends Cloudflare.Container<
  MyContainer,
  {
    ping: () => Effect.Effect<string>;
  }
>()("EffectfulContainer") {}

export default MyContainer.make(
  {
    main: import.meta.filename,
  },
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2.ReadWrite(Storage);

    return {
      ping: () => Effect.succeed("pong"),
      fetch: Effect.gen(function* () {
        bucket.get("test.txt");
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://container");
        if (url.pathname === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }
        return HttpServerResponse.text("hello from effectful container");
      }),
    };
  }).pipe(Effect.provide(Cloudflare.R2.ReadWriteHttp)),
);
