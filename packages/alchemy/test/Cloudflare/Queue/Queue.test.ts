import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { isLiveId } from "@/Cloudflare/LocalRuntime";
import * as Provider from "@/Provider";
import { poll } from "@/Util/poll.ts";
import { State } from "@/State";
import { remote } from "@/ProviderMode";
import * as Test from "@/Test/Alchemy";
import * as queues from "@distilled.cloud/cloudflare/queues";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import ConsumerWorker from "./fixtures/dedicated-consumer-worker.ts";
import ProducerWorker from "./fixtures/dedicated-producer-worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const { test: localTest } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

localTest.provider("promotes a dev queue to a live queue on deploy", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    yield* stack.destroy();
    const local = yield* stack.deploy(Cloudflare.Queues.Queue("Q"));
    expect(isLiveId(local.queueId)).toBe(false);

    const deployed = yield* stack.deploy(
      Cloudflare.Queues.Queue("Q").pipe(remote()),
    );
    expect(isLiveId(deployed.queueId)).toBe(true);
    expect(deployed.queueId).not.toEqual(local.queueId);
    const live = yield* queues
      .getQueue({ accountId, queueId: deployed.queueId })
      .pipe(
        Effect.retry({
          while: (e) => e._tag === "QueueNotFound",
          schedule: Schedule.spaced("2 seconds"),
          times: 8,
        }),
      );
    expect(live.queueId).toEqual(deployed.queueId);
    const persisted = yield* Effect.gen(function* () {
      const state = yield* yield* State;
      return yield* state.get({
        stack: stack.name,
        stage: stack.stage,
        fqn: "Q",
      });
    }).pipe(Effect.provide(stack.state));
    expect((persisted as any)?.attr?.queueId).toEqual(deployed.queueId);
    yield* stack.destroy();
    const missing = yield* queues
      .getQueue({ accountId, queueId: deployed.queueId })
      .pipe(
        Effect.as(false),
        Effect.catchTag("QueueNotFound", () => Effect.succeed(true)),
      );
    expect(missing).toBe(true);
  }).pipe(logLevel),
);

// Canonical `list()` test (account-scoped collection): deploy a real
// queue, resolve the provider from context via `findProvider`, call
// `list()`, and assert the deployed queue appears in the exhaustively-
// paginated result.
test.provider("list enumerates the deployed queue", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const deployed = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Queues.Queue("ListQueue");
      }),
    );

    const provider = yield* Provider.findProvider(Cloudflare.Queues.Queue);

    // A just-created queue can lag the account-wide list under load — poll
    // until it shows up (bounded) instead of asserting on the first read.
    const all = yield* poll({
      description: "list() includes the deployed queue",
      effect: provider.list(),
      predicate: (all) => all.some((q) => q.queueId === deployed.queueId),
      schedule: Schedule.max([
        Schedule.spaced("2 seconds"),
        Schedule.recurs(10),
      ]),
    });

    expect(all.some((q) => q.queueId === deployed.queueId)).toBe(true);

    yield* stack.destroy();
  }).pipe(logLevel),
);

localTest.provider("destroys a deployed local queue", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();
    const local = yield* stack.deploy(Cloudflare.Queues.Queue("Q"));
    expect(isLiveId(local.queueId)).toBe(false);
    yield* stack.destroy();
    const persisted = yield* Effect.gen(function* () {
      const state = yield* yield* State;
      return yield* state.get({
        stack: stack.name,
        stage: stack.stage,
        fqn: "Q",
      });
    }).pipe(Effect.provide(stack.state));
    expect(persisted).toBeUndefined();
    yield* stack.destroy();
  }).pipe(logLevel),
);

/**
 * Regression test for #1243 — producer and consumer split across two
 * Workers, so the consuming Worker has no producer binding and learns its
 * queue's name only from the `DedicatedQueue_queueName` env binding.
 *
 * Before the `packEnvValue` fix, that binding deployed as the JSON-packed
 * `"the-name"` (quote characters on the wire): the raw-binding assertion
 * below failed, and any consumer of the raw value — including the
 * reporter's — could never match Cloudflare's bare `MessageBatch.queue`.
 * The test pins both halves: the binding is the bare name, and the
 * handler receives the message end-to-end.
 */
test.provider.skipIf(!!process.env.FAST)(
  "dedicated consumer worker deploys a bare queue-name binding and receives messages",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const producer = yield* ProducerWorker;
          const consumer = yield* ConsumerWorker;
          return {
            producer: producer.url.as<string>(),
            consumer: consumer.url.as<string>(),
          };
        }),
      );

      const client = yield* HttpClient.HttpClient;
      // Fresh workers.dev URLs 404 for a few seconds; retry through it.
      const get = (url: string) =>
        client.get(url).pipe(
          Effect.flatMap((res) =>
            res.status < 300
              ? Effect.succeed(res)
              : Effect.fail(new Error(`Worker not ready: ${res.status}`)),
          ),
          Effect.retry({
            schedule: Schedule.max([
              Schedule.min([
                Schedule.exponential("500 millis"),
                Schedule.spaced("3 seconds"),
              ]),
              Schedule.recurs(30),
            ]),
          }),
          Effect.orDie,
        );

      // The raw env binding is the bare queue name — no quote characters
      // on the wire (#1243: it deployed as `"the-name"`).
      const binding = (yield* (yield* get(`${out.consumer}/binding`)).json) as {
        queueName: string;
      };
      expect(binding.queueName).not.toMatch(/^"/);
      expect(binding.queueName).toMatch(/queue/);

      yield* get(`${out.producer}/send?text=dedicated`);

      const received = yield* get(`${out.consumer}/received`).pipe(
        Effect.flatMap((res) => res.json),
        Effect.map((body) => (body as { bodies?: string[] })?.bodies ?? []),
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (bodies) => bodies.includes("dedicated"),
          times: 45,
        }),
        Effect.orDie,
      );
      expect(received).toContain("dedicated");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 300_000 },
);
