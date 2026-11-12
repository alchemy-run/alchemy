/**
 * Deploys the bank to the target `BANK_TARGET` names (`docker`, the default,
 * or `cloudflare`) and drives its HTTP Api end to end: commands, rejections,
 * views, and the transfer saga's success and refund.
 *
 *   bun test test/integ.test.ts                          # Docker
 *   BANK_TARGET=cloudflare bun test test/integ.test.ts   # Cloudflare
 */
import { expect } from "bun:test";
import * as AWS from "@alchemy.run/aws";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Docker from "@alchemy.run/docker";
import * as Cluster from "@alchemy.run/effect-cluster";
import * as Test from "@alchemy.run/test/Bun";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  // The same providers the stack registers.
  providers: Layer.mergeAll(
    AWS.providers(),
    Cloudflare.providers(),
    Docker.providers(),
    Cluster.providers(),
  ),
  state: Alchemy.localState(),
});

const stack = beforeAll(destroy(Stack).pipe(Effect.andThen(deploy(Stack))), {
  timeout: 600_000,
});
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 600_000 });

/** The deployed Api's URL; a deploy that printed none fails the test. */
const deployedUrl = Effect.flatMap(stack, ({ url }) =>
  url ? Effect.succeed(url) : Effect.die(new Error("the stack printed no url")),
);

interface Answer {
  readonly status: number;
  readonly body: any;
}

/** One HTTP call as `customer`, answering its status and JSON body. */
const call = (
  url: string,
  method: "GET" | "POST",
  path: string,
  customer?: string,
  body?: unknown,
) =>
  Effect.gen(function* () {
    const base =
      method === "GET"
        ? HttpClientRequest.get(`${url}${path}`)
        : HttpClientRequest.post(`${url}${path}`);
    const withCustomer = customer
      ? base.pipe(HttpClientRequest.setHeader("x-customer", customer))
      : base;
    const request =
      body === undefined ? withCustomer : withCustomer.pipe(HttpClientRequest.bodyJsonUnsafe(body));
    const response = yield* HttpClient.execute(request);
    const text = yield* response.text;
    // Not JSON (a fresh workers.dev URL's HTML placeholder): keep the text.
    const parsed = text
      ? yield* Effect.try(() => JSON.parse(text) as unknown).pipe(Effect.orElseSucceed(() => text))
      : null;
    return { status: response.status, body: parsed } as Answer;
  }).pipe(Effect.provide(FetchHttpClient.layer));

/**
 * The Api's URL once the bank answers through it. A fresh workers.dev URL
 * serves an HTML placeholder for a few seconds, a fresh swarm service
 * refuses connections, and the Api can answer before the pool behind it
 * does, so every test waits for a view read, which reaches the model, to
 * answer 200.
 */
const bankUrl = Effect.gen(function* () {
  const url = yield* deployedUrl;
  yield* call(url, "GET", "/AccountSummary/ready", "probe").pipe(
    Effect.flatMap((answer) => (answer.status === 200 ? Effect.void : Effect.fail(answer))),
    Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 45 }),
  );
  return url;
}).pipe(Effect.cached, Effect.runSync);

/** Each command in this file has its own id: one id sent twice is one command, replayed. */
let commands = 0;

const command = (url: string, name: string, customer: string, target: string, input: unknown) =>
  call(url, "POST", `/${name}`, customer, {
    target,
    commandId: `${name}-${customer}-${target}-${++commands}`,
    input,
  });

/** Read a view until `done` holds: views and the saga catch up after the command commits. */
const readUntil = (url: string, path: string, customer: string, done: (state: any) => boolean) =>
  call(url, "GET", path, customer).pipe(
    Effect.map((answer) => answer.body),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (s) => s !== null && done(s),
      times: 30,
    }),
  );

test(
  "the deployed bank serves its Api reference and OpenAPI document",
  Effect.gen(function* () {
    const url = yield* bankUrl;
    const docs = yield* call(url, "GET", "/openapi.json");
    expect(Object.keys(docs.body.paths)).toContain("/OpenAccount");
    const page = yield* HttpClient.get(`${url}/`).pipe(Effect.provide(FetchHttpClient.layer));
    expect(page.status).toBe(200);
  }),
  { timeout: 180_000 },
);

test(
  "accounts take deposits and refuse overdrafts and strangers",
  Effect.gen(function* () {
    const url = yield* bankUrl;
    expect((yield* command(url, "OpenAccount", "sam", "sam-a", { name: "everyday" })).status).toBe(
      200,
    );
    const deposit = yield* command(url, "DepositMoney", "sam", "sam-a", { amount: 100 });
    expect(deposit.body.reply).toEqual({ balance: 100 });

    const overdraft = yield* command(url, "WithdrawMoney", "sam", "sam-a", { amount: 500 });
    expect(overdraft).toEqual({
      status: 409,
      body: { _tag: "InsufficientFunds", balance: 100, requested: 500 },
    });

    const stranger = yield* command(url, "DepositMoney", "eve", "sam-a", { amount: 1 });
    expect(stranger).toEqual({ status: 403, body: { _tag: "NotOwner" } });

    const anonymous = yield* call(url, "POST", "/DepositMoney", undefined, {
      target: "sam-a",
      commandId: "anon",
      input: { amount: 1 },
    });
    expect(anonymous.status).toBe(401);

    const summary = yield* readUntil(url, "/AccountSummary/sam-a", "sam", (s) => s.balance === 100);
    expect(summary).toMatchObject({ customerId: "sam", name: "everyday", balance: 100 });
  }),
  { timeout: 180_000 },
);

test(
  "a transfer debits, credits and completes, through the saga",
  Effect.gen(function* () {
    const url = yield* bankUrl;
    yield* command(url, "OpenAccount", "sam", "sam-t", { name: "everyday" });
    yield* command(url, "OpenAccount", "ada", "ada-t", { name: "savings" });
    yield* command(url, "DepositMoney", "sam", "sam-t", { amount: 100 });

    yield* command(url, "RequestTransfer", "sam", "t-ok", {
      from: "sam-t",
      to: "ada-t",
      amount: 40,
    });
    const status = yield* readUntil(
      url,
      "/TransferStatus/t-ok",
      "sam",
      // The view folds the Transfer's and both accounts' events, in any
      // order: wait for every fact this asserts, or for a failure.
      (s) => (s.completed && s.debited && s.credited) || s.failedReason,
    );
    expect(status).toMatchObject({
      debited: true,
      credited: true,
      completed: true,
      failedReason: null,
    });

    expect(
      yield* readUntil(url, "/AccountSummary/ada-t", "ada", (s) => s.balance === 40),
    ).toMatchObject({
      balance: 40,
    });
    expect(
      yield* readUntil(url, "/AccountSummary/sam-t", "sam", (s) => s.balance === 60),
    ).toMatchObject({
      balance: 60,
    });
  }),
  { timeout: 180_000 },
);

test(
  "a transfer to an account that doesn't exist is refunded",
  Effect.gen(function* () {
    const url = yield* bankUrl;
    yield* command(url, "OpenAccount", "sam", "sam-r", { name: "everyday" });
    yield* command(url, "DepositMoney", "sam", "sam-r", { amount: 100 });

    yield* command(url, "RequestTransfer", "sam", "t-refund", {
      from: "sam-r",
      to: "nobody",
      amount: 10,
    });
    const status = yield* readUntil(
      url,
      "/TransferStatus/t-refund",
      "sam",
      (s) => s.failedReason && s.debited && s.refunded,
    );
    expect(status).toMatchObject({
      debited: true,
      credited: false,
      refunded: true,
      failedReason: "destination account not open",
    });
    expect(
      yield* readUntil(url, "/AccountSummary/sam-r", "sam", (s) => s.movements === 3),
    ).toMatchObject({
      balance: 100,
    });
  }),
  { timeout: 180_000 },
);
