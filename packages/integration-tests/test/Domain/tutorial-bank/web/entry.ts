import * as Domain from "@alchemy.run/domain";
import { BrowserHost } from "@effect/ui/html";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Socket from "effect/socket/Socket";
import { BankApi } from "../BankApi.api.ts";
import { CustomerId } from "../Customer.id.ts";
import { Bank } from "./Bank.ts";

// A stand-in for a login page: `?customer=c-2` picks who you are.
const customerId = CustomerId.make(new URLSearchParams(location.search).get("customer") ?? "c-1");

// Sign in, so the browser holds the session cookie for every call and watch.
const signIn = Effect.gen(function* () {
  const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
  yield* client.execute(
    HttpClientRequest.post("/api/session").pipe(HttpClientRequest.bodyJsonUnsafe({ customerId })),
  );
});

const BankConnection = Layer.unwrap(
  signIn.pipe(
    Effect.orDie,
    Effect.as(
      BankApi.layerClient.pipe(
        Layer.provide(Domain.protocolWebSocket(`${location.origin}/api`)),
        Layer.provide(Socket.layerWebSocketConstructorGlobal),
      ),
    ),
  ),
).pipe(Layer.provide(FetchHttpClient.layer));

const Main = BrowserHost.mount(Bank, { customerId }, document.getElementById("root")!).pipe(
  Layer.provide(BankConnection),
);

Layer.launch(Main).pipe(Effect.runFork);
