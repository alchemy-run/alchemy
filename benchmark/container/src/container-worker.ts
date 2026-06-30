import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { BunObject } from "./bun-object.ts";
import { EffectfulObject } from "./effectful-object.ts";
import { RemoteObject } from "./remote-object.ts";

/**
 * Cloudflare Worker host for the container cold-start benchmark. Each request
 * names a fresh DO instance (`?name=`), which boots its own container and
 * reports the time-to-usable-service measured inside the DO:
 *
 * - `GET /boot?variant=effectful|bun|remote&name=K` boots one container and
 *   returns `{ readyMs }`. It does NOT shut down.
 * - `GET /shutdown?variant=…&name=K` tears the container down so the next boot
 *   is an independent cold start and the account's container cap isn't exhausted.
 */
export default class ContainerWorker extends Cloudflare.Worker<ContainerWorker>()(
  "BenchContainerWorker",
  {
    main: import.meta.filename,
  },
  Effect.gen(function* () {
    const effectful = yield* EffectfulObject;
    const remote = yield* RemoteObject;
    const bun = yield* BunObject;

    const objectFor = (variant: string) =>
      variant === "remote" ? remote : variant === "bun" ? bun : effectful;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const name = url.searchParams.get("name") ?? "default";
        const variant = url.searchParams.get("variant") ?? "effectful";

        if (url.pathname === "/boot") {
          const result = yield* objectFor(variant).getByName(name).boot();
          return yield* HttpServerResponse.json(result);
        }
        if (url.pathname === "/shutdown") {
          yield* objectFor(variant).getByName(name).shutdown();
          return yield* HttpServerResponse.json({ ok: true });
        }
        return HttpServerResponse.text("ok");
      }).pipe(
        Effect.catch((err) =>
          Effect.succeed(HttpServerResponse.text(String(err), { status: 500 })),
        ),
      ),
    };
  }),
) {}
