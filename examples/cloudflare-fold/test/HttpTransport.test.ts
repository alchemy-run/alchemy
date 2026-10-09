import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { expect, it } from "@effect/vitest";
import { Api, InMemory } from "alchemy/Fold";
import * as Effect from "effect/Effect";
import * as HttpServer from "effect/http/HttpServer";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { Bank, BankPolicies } from "../src/Bank.ts";
import { CustomerApi, CustomerApiLive } from "../src/CustomerApi/CustomerApi.ts";
import { CustomerSessionLive, customerSessionClient } from "../src/CustomerApi/CustomerSession.ts";
import { MfaChallengeLive } from "../src/CustomerApi/MfaChallenge.ts";
import { SiftFraudCheck } from "../src/Fraud/SiftFraudCheck.ts";
import { StripePayments } from "../src/Settlement/StripePayments.ts";

// The Worker's HTTP surface (`CustomerApi.httpEffect`) on a real HTTP server, over the in-memory platform.
const Ports = Layer.mergeAll(SiftFraudCheck, StripePayments);
const World = Layer.mergeAll(CustomerApiLive, CustomerSessionLive, MfaChallengeLive).pipe(
  Layer.provideMerge(Bank.layer(BankPolicies).pipe(Layer.provide(Layer.mergeAll(Ports, InMemory)))),
);

// A test server on a random port, plus an HttpClient pointed at it.
const Served = Layer.unwrap(
  Effect.map(CustomerApi.httpEffect, (http) => HttpServer.serve()(http)),
).pipe(Layer.provideMerge(NodeHttpServer.layerTest), Layer.provide(World));

// The test server serves the Api at its root; its HttpClient already targets the server.
const Client = Layer.mergeAll(Api.protocolHttp(""), customerSessionClient("customer:c-1"));

it.live("the CustomerApi round-trips over HTTP, including a streamed subscription", () =>
  Effect.gen(function* () {
    const sam = yield* CustomerApi.client;
    const { accountId } = yield* sam.register({ name: "sam" });
    yield* sam.deposit({ accountId, amount: 70 });
    const dashboard = yield* sam.dashboard({}).pipe(
      Stream.filter((d) => d.totalBalance === 70),
      Stream.runHead,
    );
    expect(accountId as string).toBe("c-1-main");
    expect(Option.getOrThrow(dashboard)).toMatchObject({ name: "sam", totalBalance: 70 });
  }).pipe(Effect.provide(Client.pipe(Layer.provideMerge(Served))), Effect.scoped),
);
