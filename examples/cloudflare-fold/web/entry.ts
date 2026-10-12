import { Api } from "alchemy/Fold";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { Runtime } from "foldkit";
import { CustomerId } from "../src/Customer/CustomerId.ts";
import { CustomerApi } from "../src/CustomerApi/CustomerApi.ts";
import { sessionClient } from "../src/Session.ts";
import { Flags, init, Model, subscriptions, update, view } from "./Bank.ts";

/** The signed-in customer, as the sign-in page left it. */
const signedIn = Effect.sync(() => localStorage.getItem("bank-customer") ?? "");

/** The bank Api for the life of the app, carrying the customer's session token. */
const BankConnection = Layer.unwrap(
  Effect.gen(function* () {
    const customerId = yield* signedIn;
    const url = yield* Effect.sync(() => `${location.origin}/api`);
    return CustomerApi.layerClient.pipe(
      Layer.provide(Layer.mergeAll(Api.protocolHttp(url), sessionClient(`customer:${customerId}`))),
      Layer.provide(FetchHttpClient.layer),
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
  {
    flags: signedIn.pipe(Effect.map((customerId) => ({ customerId: CustomerId.make(customerId) }))),
  },
);
