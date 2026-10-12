import { Api } from "alchemy/Fold";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Socket from "effect/socket/Socket";
import { Runtime } from "foldkit";
import { CustomerId } from "../Customer/CustomerId.ts";
import { CustomerApi } from "../CustomerApi/CustomerApi.ts";
import { Flags, init, Model, subscriptions, update, view } from "./Bank.ts";

/**
 * The signed-in customer. A demo stand-in for a login: `?customer=c-2` picks
 * who you are, defaulting to `c-1`.
 */
const signedIn = Effect.sync(() =>
  CustomerId.make(new URLSearchParams(location.search).get("customer") ?? "c-1"),
);

/** Sign in: the Api sets an `HttpOnly` session cookie on this origin. */
const signIn = Effect.fn(function* (customerId: CustomerId) {
  const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
  yield* client.execute(
    HttpClientRequest.post("/api/session").pipe(HttpClientRequest.bodyJsonUnsafe({ customerId })),
  );
});

/**
 * The bank Api for the life of the app, on this origin, so the browser sends
 * the session cookie with every call and every watch. Commands go over HTTP;
 * each watch is a WebSocket to the Durable Object that owns what it reads,
 * which pushes every change.
 */
const BankConnection = Layer.unwrap(
  Effect.gen(function* () {
    // The app cannot run signed out.
    yield* signIn(yield* signedIn).pipe(Effect.orDie);
    return CustomerApi.layerClient.pipe(
      Layer.provide(Api.protocolWebSocket(`${location.origin}/api`)),
      Layer.provide(Socket.layerWebSocketConstructorGlobal),
    );
  }),
).pipe(Layer.provide(FetchHttpClient.layer));

Runtime.run(
  Runtime.makeApplication({
    Model,
    Flags,
    init,
    update,
    view,
    subscriptions,
    resources: BankConnection,
    container: document.getElementById("root"),
  }),
  {
    flags: Effect.all({
      customerId: signedIn,
      // Names this page's commands, so each is unique even across reloads.
      session: Effect.sync(() => crypto.randomUUID()),
    }),
  },
);
