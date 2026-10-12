import { Api } from "alchemy/Fold";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Socket from "effect/socket/Socket";
import { Runtime } from "foldkit";
import { CustomerId } from "../Customer/CustomerId.ts";
import { CustomerApi } from "../CustomerApi/CustomerApi.ts";
import { sessionClient } from "../Session.ts";
import { Flags, init, Model, subscriptions, update, view } from "./Bank.ts";

/**
 * The signed-in customer. A demo stand-in for a login: `?customer=c-2` picks
 * who you are, defaulting to `c-1`.
 */
const signedIn = Effect.sync(() =>
  CustomerId.make(new URLSearchParams(location.search).get("customer") ?? "c-1"),
);

/**
 * The bank Api for the life of the app, carrying the customer's session
 * token. Commands go over HTTP; each watch is a WebSocket to the Durable
 * Object that owns what it reads, which pushes every change.
 */
const BankConnection = Layer.unwrap(
  Effect.gen(function* () {
    const customerId = yield* signedIn;
    return CustomerApi.layerClient.pipe(
      Layer.provide(
        Layer.mergeAll(
          Api.protocolWebSocket(`${import.meta.env.VITE_BANK_URL}/api`),
          sessionClient(`customer:${customerId}`),
        ),
      ),
      Layer.provide(Layer.mergeAll(FetchHttpClient.layer, Socket.layerWebSocketConstructorGlobal)),
    );
  }),
);

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
  { flags: signedIn.pipe(Effect.map((customerId) => ({ customerId }))) },
);
