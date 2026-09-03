/**
 * alchemy/Http routes: a class per endpoint, an implementation per Layer,
 * mounted into Effect's HttpApi unchanged.
 */
import * as Http from "@/Http/index.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";
import { describe, expect, it } from "alchemy-test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as HttpClient from "effect/unstable/http/HttpClient";

class Caller extends Context.Service<Caller, { readonly name: string }>()(
  "test/Caller",
) {}

class Session extends HttpApiMiddleware.Service<
  Session,
  { provides: Caller }
>()("test/Session") {}

const SessionLive = Layer.succeed(Session, (httpEffect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    return yield* Effect.provideService(httpEffect, Caller, {
      name: request.headers["x-user"] ?? "anonymous",
    });
  }),
);

class NotFound extends Schema.TaggedError<NotFound>()(
  "NotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {}

const Item = Schema.Struct({ id: Schema.String, owner: Schema.String });

// A route with params, a declared error, and a middleware it relies on.
class GetItem extends Http.get<GetItem>()("get", "/items/:id", {
  params: { id: Schema.String },
  success: Item,
  error: NotFound,
  middleware: [Session],
}) {}

// A route without middleware, with a payload.
class CreateItem extends Http.post<CreateItem>()("create", "/items", {
  payload: Schema.Struct({ id: Schema.String }),
  success: Item,
}) {}

// A plain Effect endpoint in its own group, implemented by hand.
const Ping = HttpApiEndpoint.get("ping", "/ping", { success: Schema.String });

class Items extends HttpApiGroup.make("items").add(GetItem, CreateItem) {}
class Misc extends HttpApiGroup.make("misc").add(Ping) {}

class Api extends HttpApi.make("test").add(Items).add(Misc).prefix("/api") {}

const GetItemLive = GetItem.make(
  Effect.gen(function* () {
    const store = new Map([["a", "acme"]]);
    return Effect.fn(function* ({ params }) {
      const caller = yield* Caller;
      const owner = store.get(params.id);
      if (owner === undefined) return yield* new NotFound({ id: params.id });
      return { id: params.id, owner: `${owner} via ${caller.name}` };
    });
  }),
);

const CreateItemLive = CreateItem.make(
  Effect.succeed(({ payload }) =>
    Effect.succeed({ id: payload.id, owner: "created" }),
  ),
);

const MiscLive = HttpApiBuilder.group(Api, "misc", (h) =>
  h.handle("ping", () => Effect.succeed("pong")),
);

const serve = (handlers: Layer.Layer<never, never, any>) =>
  Effect.gen(function* () {
    const handler = yield* HttpApiBuilder.layer(Api).pipe(
      Layer.provide(Http.handlers(Api)),
      Layer.provide(handlers),
      Layer.provide(SessionLive),
      Layer.provide(MiscLive),
      Layer.provide(Http.Platform),
      HttpRouter.toHttpEffect,
    );
    return (request: Request) =>
      handler.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(request),
        ),
        Effect.provide(RuntimeContext.phantom),
        Effect.scoped,
        Effect.map((response) => ({
          status: response.status,
          text: new TextDecoder().decode(
            ((response as any).body?.body ?? new Uint8Array()) as Uint8Array,
          ),
        })),
      );
  });

describe("Http routes", () => {
  it.effect("mounts route groups under the API's middleware", () =>
    Effect.gen(function* () {
      const fetch = yield* serve(Layer.mergeAll(GetItemLive, CreateItemLive));
      const ok = yield* fetch(
        new Request("http://x/api/items/a", { headers: { "x-user": "dana" } }),
      );
      expect(ok.status).toBe(200);
      expect(JSON.parse(ok.text)).toEqual({ id: "a", owner: "acme via dana" });

      const missing = yield* fetch(new Request("http://x/api/items/zz"));
      expect(missing.status).toBe(404);
      expect(JSON.parse(missing.text)._tag).toBe("NotFound");

      const created = yield* fetch(
        new Request("http://x/api/items", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: "b" }),
        }),
      );
      expect(created.status).toBe(200);
      expect(JSON.parse(created.text)).toEqual({ id: "b", owner: "created" });

      const pong = yield* fetch(new Request("http://x/api/ping"));
      expect(pong.status).toBe(200);
    }).pipe(Effect.scoped),
  );

  it.effect("the nearer implementation wins", () =>
    Effect.gen(function* () {
      const GetItemOther = GetItem.make(
        Effect.succeed(({ params }) =>
          Effect.succeed({ id: params.id, owner: "other" }),
        ),
      );
      const handler = yield* HttpApiBuilder.layer(Api).pipe(
        Layer.provide(Http.handlers(Api)),
        Layer.provide(GetItemOther),
        Layer.provide(Layer.mergeAll(GetItemLive, CreateItemLive)),
        Layer.provide(SessionLive),
        Layer.provide(MiscLive),
        Layer.provide(Http.Platform),
        HttpRouter.toHttpEffect,
      );
      const response = yield* handler.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(new Request("http://x/api/items/a")),
        ),
        Effect.provide(RuntimeContext.phantom),
        Effect.scoped,
      );
      const body = new TextDecoder().decode(
        ((response as any).body?.body ?? new Uint8Array()) as Uint8Array,
      );
      expect(JSON.parse(body)).toEqual({ id: "a", owner: "other" });
    }).pipe(Effect.scoped),
  );

  it("the typed client sees the same API", () => {
    // Compile-time only: the route classes are ordinary endpoints.
    const make = Effect.gen(function* () {
      const client = yield* HttpApiClient.make(Api, { baseUrl: "http://x" });
      return client.items.get({ params: { id: "a" } });
    });
    expect(typeof make).toBe("object");
    void HttpClient.HttpClient;
  });
});
