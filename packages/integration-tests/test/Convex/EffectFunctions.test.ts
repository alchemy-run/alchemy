import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Convex from "@alchemy.run/convex";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import ConvexEffectWorker from "./fixtures/effect-worker.ts";
import { EffectDeployment } from "./fixtures/resources.ts";
import { EFFECT_FIXTURE_DIR } from "./support.ts";

const providers = Layer.mergeAll(Convex.providers(), Cloudflare.providers());
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers, dev: true });

const Stack = Alchemy.Stack(
  "ConvexEffectStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const deployment = yield* EffectDeployment;
    yield* Convex.Functions("EffectFunctions", {
      deployment,
      rootDir: EFFECT_FIXTURE_DIR,
      env: { MESSAGE_PREFIX: "> " },
    });
    const worker = yield* ConvexEffectWorker;
    return { url: worker.url.as<string>() };
  }),
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

type Reply = { value?: any; tag?: string; message?: string };

const get = (path: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    const res = yield* client
      .get(`${url}${path}`)
      .pipe(Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 8 }));
    return (yield* res.json) as Reply;
  });

const options = {
  tags: ["provider:convex", "provider:convex:functions", "live"],
  timeout: 120_000,
};

test(
  "a mutation inserts through its Layer and a query reads it back decoded",
  Effect.gen(function* () {
    const added = yield* get("/add?channel=general&body=hello");
    expect(added.tag).toBeUndefined();
    expect(typeof added.value).toBe("string");

    const { value } = yield* get("/list?channel=general");
    const message = value.find((row: { id: string }) => row.id === added.value);
    // The constructor read MESSAGE_PREFIX from the deployment's variables.
    expect(message.body).toBe("> hello");
    // sentAt is stored as a number and decoded back into a Date.
    expect(message.sentAtIsDate).toBe(true);

    const { value: found } = yield* get(`/get?id=${added.value}`);
    expect(found).toBe("Some");
  }),
  options,
);

test(
  "a declared failure reaches the caller as its typed error",
  Effect.gen(function* () {
    const { tag } = yield* get("/add?channel=&body=hello");
    expect(tag).toBe("EmptyChannel");
  }),
  options,
);

test(
  "a failed mutation discards what it wrote",
  Effect.gen(function* () {
    expect((yield* get("/add-then-fail?channel=rollback")).tag).toBe("EmptyChannel");
    expect((yield* get("/list?channel=rollback")).value).toEqual([]);
  }),
  options,
);

test(
  "a value that fails the table schema fails the call and stores nothing",
  Effect.gen(function* () {
    // The arguments allow any channel; the table allows 20 characters.
    const channel = "a-channel-name-that-is-too-long";
    const { tag, message } = yield* get(`/add?channel=${channel}&body=hello`);
    expect(tag).toBe("ConvexFunctionError");
    expect(message).toContain("SchemaError");
    const { value } = yield* get(`/list?channel=${channel}`);
    expect(value).toEqual([]);
  }),
  options,
);

test(
  "a scheduled mutation runs after the insert commits",
  Effect.gen(function* () {
    const added = yield* get("/add?channel=scheduled&body=later");
    const delivered = yield* get("/list?channel=scheduled").pipe(
      Effect.map(({ value }) => value.find((row: { id: string }) => row.id === added.value)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (row) => row?.delivered === true,
        times: 30,
      }),
    );
    expect(delivered.delivered).toBe(true);
  }),
  options,
);

test(
  "an action runs a query and a mutation",
  Effect.gen(function* () {
    yield* get("/add?channel=summary&body=one");
    yield* get("/add?channel=summary&body=two");
    const { value } = yield* get("/summarize?channel=summary");
    expect(value).toBe(2);
    const { value: rows } = yield* get("/list?channel=summary");
    expect(rows.map((row: { body: string }) => row.body)).toContain("> 2 messages");
  }),
  options,
);

test(
  "an anonymous caller has no identity",
  Effect.gen(function* () {
    expect((yield* get("/whoami")).value).toBeNull();
  }),
  options,
);
