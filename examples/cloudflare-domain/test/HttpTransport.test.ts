import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { expect, it } from "@effect/vitest";
import * as Domain from "alchemy/Domain";
import * as Effect from "effect/Effect";
import * as HttpServer from "effect/http/HttpServer";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { Bank, BankHandlers } from "../src/Bank.ts";
import { CustomerDashboard } from "../src/Customer/CustomerDashboard.ts";
import { CustomerId } from "../src/Customer/CustomerId.ts";
import { CustomerApi } from "../src/CustomerApi/CustomerApi.ts";
import { SiftFraudCheck } from "../src/Fraud/SiftFraudCheck.ts";
import { MemoryLedgerStore } from "../src/Ledger/LedgerStore.ts";
import { MfaChallengeLive } from "../src/MfaChallenge.ts";
import { SessionLive, sessionClient } from "../src/Session.ts";
import { StripePayments } from "../src/Settlement/StripePayments.ts";
import { register } from "./flows.ts";

// The Worker's HTTP surface (`CustomerApi.httpEffect`) on a real HTTP server, over the in-memory platform.
const Ports = Layer.mergeAll(SiftFraudCheck, StripePayments, MemoryLedgerStore);
const World = Layer.mergeAll(SessionLive, MfaChallengeLive).pipe(
  Layer.provideMerge(
    Bank.layer(BankHandlers).pipe(Layer.provide(Layer.mergeAll(Ports, Domain.InMemory))),
  ),
);

// A test server on a random port, plus an HttpClient pointed at it.
const Served = Layer.unwrap(
  Effect.map(CustomerApi.httpEffect, (http) => HttpServer.serve()(http)),
).pipe(Layer.provideMerge(NodeHttpServer.layerTest), Layer.provide(World));

// The test server serves the Api at its root; its HttpClient already targets the server.
const Client = Layer.mergeAll(Domain.protocolHttp(""), sessionClient("customer:c-1"));

it.live("the CustomerApi round-trips over HTTP, including a streamed watch", () =>
  Effect.gen(function* () {
    const sam = yield* CustomerApi.client;
    const accountId = yield* register(sam, "c-1", "sam");
    yield* sam.DepositMoney({ target: accountId, amount: 70 });
    const dashboard = yield* sam.CustomerDashboard.watch(CustomerId.make("c-1")).pipe(
      Stream.filter((d) => d !== null && CustomerDashboard.computed.totalBalance(d) === 70),
      Stream.runHead,
    );
    expect(accountId as string).toBe("c-1-main");
    expect(Option.getOrThrow(dashboard)).toMatchObject({ name: "sam" });
  }).pipe(Effect.provide(Client.pipe(Layer.provideMerge(Served))), Effect.scoped),
);
