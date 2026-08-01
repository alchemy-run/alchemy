import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { DrizzleUsersObject } from "./object.ts";

export default class DrizzleDurableObjectWorker extends Cloudflare.Worker<DrizzleDurableObjectWorker>()(
  "DrizzleDurableObjectWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const objects = yield* DrizzleUsersObject;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const object = objects.getByName(
          url.searchParams.get("do") ?? "default",
        );

        if (request.method === "POST" && url.pathname === "/users") {
          const name = url.searchParams.get("name") ?? "anonymous";
          yield* object.addUser(name).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "GET" && url.pathname === "/users") {
          const names = yield* object.listUsers().pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ names });
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }),
) {}
