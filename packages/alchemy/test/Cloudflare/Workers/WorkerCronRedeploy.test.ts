import { AlchemyContext } from "@/AlchemyContext";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { LiveWorkerProvider } from "@/Cloudflare/Workers/WorkerProvider";
import { Worker, type WorkerProps } from "@/Cloudflare/Workers/Worker";
import { InstanceId } from "@/InstanceId";
import * as Provider from "@/Provider";
import { noopSession } from "@/Report";
import type { ResourceBinding } from "@/Resource";
import { Stack } from "@/Stack";
import { Stage } from "@/Stage";
import {
  apiTokenCredentials,
  Credentials,
} from "@distilled.cloud/cloudflare/Credentials";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

const expression = "*/15 * * * *";
const workerName = "cron-redeploy";
const scriptPath = `/client/v4/accounts/test-account/workers/scripts/${workerName}`;
const session = { ...noopSession, note: () => Effect.void };

// Exercise the real provider and SDK serialization. This models the API's
// visible schedule list, not Cloudflare's internal scheduler: matching GET
// results cannot tell us whether a trigger is still delivering invocations.
const harness = () => {
  let schedules: { cron: string }[] = [];
  const writes: { cron: string }[][] = [];
  const calls: string[] = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const path = new URL(request.url).pathname;
      calls.push(`${request.method} ${path}`);
      let result: object;
      if (path === `${scriptPath}/schedules`) {
        if (request.method === "PUT") {
          expect(request.body._tag).toBe("Uint8Array");
          if (request.body._tag !== "Uint8Array") {
            throw new Error("Expected a JSON schedule body");
          }
          schedules = JSON.parse(new TextDecoder().decode(request.body.body));
          writes.push(schedules);
        }
        result = { schedules };
      } else if (
        path === `${scriptPath}/settings` &&
        request.method === "GET"
      ) {
        result = { bindings: [], tags: [] };
      } else if (
        path === `${scriptPath}/subdomain` &&
        request.method === "GET"
      ) {
        result = { enabled: false, previews_enabled: false };
      } else if (path === scriptPath && request.method === "PUT") {
        result = { id: workerName, tag: "immutable-worker-id" };
      } else {
        throw new Error(`Unexpected request: ${request.method} ${path}`);
      }
      return HttpClientResponse.fromWeb(
        request,
        Response.json({ success: true, errors: [], messages: [], result }),
      );
    }),
  );
  const env = Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(HttpClient.HttpClient, client),
    Layer.succeed(
      Credentials,
      Effect.succeed(apiTokenCredentials({ apiToken: "test-token" })),
    ),
    Layer.succeed(
      CloudflareEnvironment,
      Effect.succeed({
        type: "apiToken",
        apiToken: Redacted.make("test-token"),
        accountId: "test-account",
        source: { type: "stored" },
      }),
    ),
    Layer.succeed(Stack, {
      name: "cron-redeploy-test",
      stage: "test",
      resources: {},
      bindings: {},
      actions: {},
    }),
    Layer.succeed(InstanceId, "00000000000000000000000000000000"),
    Layer.succeed(Stage, "test"),
    Layer.succeed(AlchemyContext, {
      dotAlchemy: "/tmp/.alchemy-cron-redeploy-test",
      dev: false,
      adopt: false,
    }),
  );
  return { env, writes, calls };
};

const props = (revision: number, crons?: string[]): WorkerProps => ({
  name: workerName,
  workersDev: false,
  script: `export default { async scheduled() { console.log(${revision}); } };`,
  crons,
});

const reconcile = (
  news: WorkerProps,
  olds?: WorkerProps,
  output?: Worker["Attributes"],
  bindings: ResourceBinding<Worker["Binding"]>[] = [],
) =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(Worker);
    return yield* provider.reconcile({
      id: "Worker",
      fqn: "Worker",
      instanceId: "00000000000000000000000000000000",
      news,
      olds,
      output,
      bindings,
      session,
    });
  });

it.effect("reapplies an unchanged cron after a code-only redeploy", () => {
  const { env, writes, calls } = harness();
  return Effect.gen(function* () {
    const before = props(1, [expression]);
    const first = yield* reconcile(before);
    expect(first.crons).toEqual([expression]);
    expect(writes).toEqual([[{ cron: expression }]]);

    calls.length = 0;
    const second = yield* reconcile(props(2, [expression]), before, first);
    expect(second.hash).not.toEqual(first.hash);
    expect(second.crons).toEqual([expression]);
    expect(writes).toEqual([[{ cron: expression }], [{ cron: expression }]]);
    expect(calls.indexOf(`PUT ${scriptPath}/schedules`)).toBeGreaterThan(
      calls.indexOf(`PUT ${scriptPath}`),
    );
  }).pipe(Effect.provide(LiveWorkerProvider()), Effect.provide(env));
});

it.effect("deduplicates cron bindings and props when resynchronizing", () => {
  const { env, writes } = harness();
  const bindings: ResourceBinding<Worker["Binding"]>[] = [
    { sid: "cron-binding", data: { crons: [expression, "0 * * * *"] } },
  ];
  return Effect.gen(function* () {
    const before = props(1, [expression]);
    const first = yield* reconcile(before, undefined, undefined, bindings);
    const second = yield* reconcile(
      props(2, [expression]),
      before,
      first,
      bindings,
    );
    expect(second.crons).toEqual([expression, "0 * * * *"]);
    expect(writes).toEqual([
      [{ cron: expression }, { cron: "0 * * * *" }],
      [{ cron: expression }, { cron: "0 * * * *" }],
    ]);
  }).pipe(Effect.provide(LiveWorkerProvider()), Effect.provide(env));
});

it.effect(
  "removes managed crons without resetting them on every deploy",
  () => {
    const { env, writes } = harness();
    return Effect.gen(function* () {
      const before = props(1, [expression]);
      const first = yield* reconcile(before);
      const cleared = props(2, []);
      const second = yield* reconcile(cleared, before, first);
      expect(second.crons).toEqual([]);
      yield* reconcile(props(3, []), cleared, second);
      expect(writes).toEqual([[{ cron: expression }], []]);
    }).pipe(Effect.provide(LiveWorkerProvider()), Effect.provide(env));
  },
);

it.effect("does not touch schedules on Workers with unmanaged crons", () => {
  const { env, calls } = harness();
  return Effect.gen(function* () {
    const before = props(1);
    const first = yield* reconcile(before);
    yield* reconcile(props(2), before, first);
    expect(calls.some((call) => call.endsWith("/schedules"))).toBe(false);
  }).pipe(Effect.provide(LiveWorkerProvider()), Effect.provide(env));
});
