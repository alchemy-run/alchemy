import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
  dev: true,
});

const stack = beforeAll(deploy(Stack));

afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "deploys both workers with URLs",
  Effect.gen(function* () {
    const { asyncWorker, effectWorker } = yield* stack;

    expect(asyncWorker).toBeString();
    expect(effectWorker).toBeString();
  }),
);

/**
 * AsyncWorker exports a default fetch handler that calls the `Counter`
 * Durable Object's `increment()` and returns `Hello, world! <n>`.
 *
 * Hitting the worker twice exercises the DO end-to-end and proves
 * persistent state across requests — if the DO binding is missing or
 * the class export is wrong, the first request fails outright.
 */
test(
  "AsyncWorker increments the Counter Durable Object across requests",
  Effect.gen(function* () {
    const { asyncWorker } = yield* stack;
    const url = asyncWorker!;

    const first = yield* HttpClient.get(url);
    expect(first.status).toBe(200);
    const firstBody = yield* first.text;
    const firstMatch = firstBody.match(/^Hello, world! (\d+)$/);
    expect(firstMatch).not.toBeNull();
    const firstCount = Number(firstMatch![1]);

    const second = yield* HttpClient.get(url);
    expect(second.status).toBe(200);
    const secondBody = yield* second.text;
    const secondMatch = secondBody.match(/^Hello, world! (\d+)$/);
    expect(secondMatch).not.toBeNull();
    const secondCount = Number(secondMatch![1]);

    expect(secondCount).toBe(firstCount + 1);
  }),
);

/**
 * EffectWorker binds a KV namespace via `Cloudflare.KVNamespace.bind(KV)`
 * and returns the result of `kv.list()` as JSON. A successful response
 * proves the Effect-style binding wired the runtime SDK and the
 * `WorkerEnvironment` service was provisioned for the fetch handler.
 */
test(
  "EffectWorker returns a KV list result via the Effect KV binding",
  Effect.gen(function* () {
    const { effectWorker } = yield* stack;

    const response = yield* HttpClient.get(effectWorker!);
    expect(response.status).toBe(200);

    const body = (yield* response.json) as {
      keys: Array<{ name: string }>;
      list_complete: boolean;
    };
    expect(Array.isArray(body.keys)).toBe(true);
    expect(typeof body.list_complete).toBe("boolean");
  }),
);

/**
 * Both workers import `./modules/wasm-example.wasm`, which exports a
 * single `add(a: number, b: number): number` function. Hitting `/wasm`
 * instantiates the module and returns `add(3, 4)` as JSON, proving that
 * the bundler ships the wasm asset to workerd and that runtime
 * `WebAssembly.instantiate` works for both the raw async-handler and
 * Effect-style entrypoints.
 */
test(
  "AsyncWorker /wasm instantiates the wasm module and returns add(3, 4)",
  Effect.gen(function* () {
    const { asyncWorker } = yield* stack;

    const response = yield* HttpClient.get(new URL("/wasm", asyncWorker!));
    expect(response.status).toBe(200);
    const body = (yield* response.json) as { result: number };
    expect(body.result).toBe(7);
  }),
);

test(
  "EffectWorker /wasm instantiates the wasm module and returns add(3, 4)",
  Effect.gen(function* () {
    const { effectWorker } = yield* stack;

    const response = yield* HttpClient.get(new URL("/wasm", effectWorker!));
    expect(response.status).toBe(200);
    const body = (yield* response.json) as { result: number };
    expect(body.result).toBe(7);
  }),
);
