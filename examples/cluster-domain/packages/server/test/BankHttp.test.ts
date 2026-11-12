import * as Domain from "@alchemy.run/domain";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpServer from "effect/http/HttpServer";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { hostBank } from "../src/BankLive.ts";
import { bankFetch } from "../src/Http.ts";

// Every front's HTTP surface on a real HTTP server, with the model in memory.
const Served = Layer.unwrap(Effect.map(bankFetch, (app) => HttpServer.serve()(app))).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(hostBank(Domain.InMemory)),
);

const post = (path: string, customer: string, body: unknown) =>
  HttpClientRequest.post(path).pipe(
    HttpClientRequest.setHeader("x-customer", customer),
    HttpClientRequest.bodyJsonUnsafe(body),
    HttpClient.execute,
  );

const get = (path: string, customer: string) =>
  HttpClientRequest.get(path).pipe(
    HttpClientRequest.setHeader("x-customer", customer),
    HttpClient.execute,
    Effect.flatMap((res) => res.json),
  );

it.live("opens accounts, deposits, and transfers over HTTP", () =>
  Effect.gen(function* () {
    yield* post("/OpenAccount", "sam", {
      target: "sam-1",
      commandId: "o-1",
      input: { name: "everyday" },
    });
    yield* post("/OpenAccount", "ada", {
      target: "ada-1",
      commandId: "o-2",
      input: { name: "savings" },
    });
    const deposit = yield* post("/DepositMoney", "sam", {
      target: "sam-1",
      commandId: "d-1",
      input: { amount: 100 },
    });
    expect(yield* deposit.json).toMatchObject({ reply: { balance: 100 } });

    yield* post("/RequestTransfer", "sam", {
      target: "t-1",
      commandId: "t-1",
      input: { from: "sam-1", to: "ada-1", amount: 40 },
    });
    const status = yield* get("/TransferStatus/t-1", "sam").pipe(
      Effect.repeat({
        schedule: Schedule.spaced("50 millis"),
        until: (s) => (s as { completed?: boolean }).completed === true,
        times: 40,
      }),
    );
    expect(status).toMatchObject({ completed: true });
    expect(yield* get("/AccountSummary/ada-1", "ada")).toMatchObject({ balance: 40 });
  }).pipe(Effect.provide(Served)),
);

it.live("a request without a session is unauthorized, and others' accounts are forbidden", () =>
  Effect.gen(function* () {
    yield* post("/OpenAccount", "sam", { target: "sam-2", commandId: "o-3", input: { name: "x" } });
    const anonymous = yield* HttpClientRequest.post("/DepositMoney").pipe(
      HttpClientRequest.bodyJsonUnsafe({ target: "sam-2", commandId: "d-2", input: { amount: 1 } }),
      HttpClient.execute,
    );
    expect(anonymous.status).toBe(401);
    const stranger = yield* post("/DepositMoney", "eve", {
      target: "sam-2",
      commandId: "d-3",
      input: { amount: 1 },
    });
    expect(stranger.status).toBe(403);
  }).pipe(Effect.provide(Served)),
);
