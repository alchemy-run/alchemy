import * as Azure from "@alchemy.run/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as web from "@distilled.cloud/azure/web";
import * as Alchemy from "alchemy";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import { AsyncContainer, AsyncFunction } from "./fixtures/async-stack.ts";
import EffectFunction from "./fixtures/effect-function.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

class NotReady extends Data.TaggedError("NotReady")<{ status: number; body: string }> {}

/**
 * `GET url` until it answers 200, through the Flex Consumption cold start and
 * role propagation: 1 + 2 + … + 128 s, about 4 minutes at most.
 */
const fetchOk = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        Effect.flatMap(res.text, (body) =>
          res.status === 200
            ? Effect.succeed(body)
            : Effect.fail(new NotReady({ status: res.status, body: body.slice(0, 200) })),
        ),
      ),
      Effect.mapError((e) =>
        e._tag === "NotReady" ? e : new NotReady({ status: 0, body: String(e) }),
      ),
      Effect.retry({ schedule: Schedule.exponential("1 second"), times: 8 }),
    );
  });

/** Poll `url` until it answers 200: for side effects of event sources (5 min). */
const pollOk = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        Effect.flatMap(res.text, (body) =>
          res.status === 200
            ? Effect.succeed(body)
            : Effect.fail(new NotReady({ status: res.status, body: body.slice(0, 200) })),
        ),
      ),
      Effect.mapError((e) =>
        e._tag === "NotReady" ? e : new NotReady({ status: 0, body: String(e) }),
      ),
      Effect.retry({ schedule: Schedule.spaced("10 seconds"), times: 30 }),
    );
  });

const getSite = (resourceGroupName: string, name: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* web.GetWebApp({ subscriptionId, resourceGroupName, name });
  });

const siteGone = (resourceGroupName: string, name: string) =>
  getSite(resourceGroupName, name).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound", "NotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 12,
    }),
  );

const roleAssignmentsOf = (principalId: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const page = yield* authorization.ListRoleAssignmentForSubscription({
      subscriptionId,
      _filter: `principalId eq '${principalId}'`,
    });
    return page.value
      .map((a) => `${a.properties?.scope?.toLowerCase()}|${a.properties?.roleDefinitionId?.split("/").pop()}`)
      .sort();
  });

// ~$0 (Flex Consumption bills per execution); ~3 min.
test.provider(
  "async function serves fetch with literal, Config, secret, and resource env",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const fn = yield* AsyncFunction;
          const container = yield* AsyncContainer;
          return {
            url: fn.url,
            name: fn.functionAppName,
            resourceGroup: fn.resourceGroup,
            managed: fn.managedApp,
            container: container.containerName,
          };
        }),
      );
      expect(out.managed).toBe(true);

      // Out of band: a Linux Flex Consumption app on Node.js 22 with a
      // system-assigned identity.
      const site = yield* getSite(out.resourceGroup, out.name);
      expect(site.kind).toContain("functionapp");
      expect(site.identity?.type).toBe("SystemAssigned");
      expect(site.properties?.functionAppConfig?.runtime?.name).toBe("node");
      expect(site.properties?.functionAppConfig?.runtime?.version).toBe("22");

      const body = JSON.parse(yield* fetchOk(`${out.url}/greet?name=azure`)) as {
        message: string;
        secretLength: number;
        container: string;
        path: string;
        node: string;
      };
      expect(body.message).toBe("hello azure");
      expect(body.secretLength).toBe("s3cret".length);
      expect(body.container).toBe(out.container);
      expect(body.path).toBe("/greet");
      expect(body.node).toMatch(/^22\./);

      yield* stack.destroy();
      expect(yield* siteGone(out.resourceGroup, out.name)).toBe("gone");
    }),
  { timeout: 900_000 },
);

const EffectStack = Alchemy.Stack(
  "AzureFunctionsEffect",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* EffectFunction;
    return {
      url: fn.url,
      name: fn.functionAppName,
      resourceGroup: fn.resourceGroup,
      principalId: fn.principalId,
    };
  }),
);

// ~$0.05/run (Service Bus Standard and Event Hubs Basic for ~15 min); ~5 min deploy.
const effect = beforeAll(deploy(EffectStack), { timeout: 900_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(EffectStack), { timeout: 600_000 });

/** A unique payload id per run (payloads, not resource names). */
const runId = (prefix: string) => `${prefix}${Date.now().toString(36)}`;

test.provider(
  "effect function serves fetch and registers one function per trigger",
  (_stack) =>
    Effect.gen(function* () {
      const out = yield* effect;
      expect(yield* fetchOk(`${out.url}/hello`)).toBe("hello from azure");

      const { subscriptionId } = yield* Azure.AzureEnvironment.current;
      const functions = yield* web
        .ListWebAppFunctions({ subscriptionId, resourceGroupName: out.resourceGroup, name: out.name })
        .pipe(
          Effect.map((page) =>
            (page.value ?? []).map((f) => (f.name ?? "").split("/").pop() ?? "").sort(),
          ),
          Effect.repeat({
            schedule: Schedule.spaced("10 seconds"),
            until: (names) => names.length >= 8,
            times: 12,
          }),
        );
      expect(functions).toEqual(
        [
          "blob-FnUploads",
          "eventgrid-UploadEvents",
          "eventhub-FnTelemetry",
          "http",
          "queue-FnJobs",
          "sbq-FnOrders",
          "sbs-FnAudit",
          "timer-yearly",
        ].sort(),
      );
    }),
  { timeout: 600_000 },
);

test.provider(
  "Storage.QueueEventSource runs the handler for an enqueued message",
  (_stack) =>
    Effect.gen(function* () {
      const out = yield* effect;
      const id = runId("q");
      yield* fetchOk(`${out.url}/queue/send?id=${id}`);
      const recorded = JSON.parse(yield* pollOk(`${out.url}/result?key=queue/${id}`));
      expect(recorded.dequeueCount).toBe(1);
    }),
  { timeout: 600_000 },
);

test.provider(
  "Storage.BlobCreatedEventSource runs the handler for an uploaded blob",
  (_stack) =>
    Effect.gen(function* () {
      const out = yield* effect;
      const id = runId("b");
      yield* fetchOk(`${out.url}/upload?key=blob/${id}`);
      const recorded = JSON.parse(yield* pollOk(`${out.url}/result?key=blob/${id}`));
      expect(recorded.url).toMatch(new RegExp(`/blob/${id}$`));
    }),
  { timeout: 600_000 },
);

test.provider(
  "EventGrid.EventGridEventSource delivers storage events to the function",
  (_stack) =>
    Effect.gen(function* () {
      const out = yield* effect;
      const id = runId("e");
      yield* fetchOk(`${out.url}/upload?key=eg/${id}.eg`);
      const recorded = JSON.parse(yield* pollOk(`${out.url}/result?key=eventgrid/${id}`));
      expect(recorded.eventType).toBe("Microsoft.Storage.BlobCreated");
    }),
  { timeout: 600_000 },
);

test.provider(
  "ServiceBus.QueueEventSource runs the handler for a sent message",
  (_stack) =>
    Effect.gen(function* () {
      const out = yield* effect;
      const id = runId("s");
      yield* fetchOk(`${out.url}/servicebus/queue?id=${id}`);
      const recorded = JSON.parse(yield* pollOk(`${out.url}/result?key=servicebus-queue/${id}`));
      expect(recorded.deliveryCount).toBe(1);
    }),
  { timeout: 600_000 },
);

test.provider(
  "ServiceBus.SubscriptionEventSource runs the handler for a published message",
  (_stack) =>
    Effect.gen(function* () {
      const out = yield* effect;
      const id = runId("t");
      yield* fetchOk(`${out.url}/servicebus/topic?id=${id}`);
      const recorded = JSON.parse(yield* pollOk(`${out.url}/result?key=servicebus-topic/${id}`));
      expect(typeof recorded.messageId).toBe("string");
    }),
  { timeout: 600_000 },
);

test.provider(
  "EventHub.EventHubEventSource runs the handler for a sent event",
  (_stack) =>
    Effect.gen(function* () {
      const out = yield* effect;
      const id = runId("h");
      yield* fetchOk(`${out.url}/eventhub?id=${id}`);
      const recorded = JSON.parse(yield* pollOk(`${out.url}/result?key=eventhub/${id}`));
      expect(recorded.size).toBeGreaterThanOrEqual(1);
    }),
  { timeout: 600_000 },
);

test.provider(
  "redeploying the effect function keeps its role assignments",
  (_stack) =>
    Effect.gen(function* () {
      const out = yield* effect;
      expect(out.principalId).toMatch(/^[0-9a-f-]{36}$/);
      const before = yield* roleAssignmentsOf(out.principalId!);
      // Host storage (3) + the fixture's producer grants (6) + event sources
      // (Jobs ×2, Orders, Audit, Telemetry).
      expect(before.length).toBe(14);

      // A changed env value updates the app in place.
      process.env.AZURE_FN_EFFECT_GREETING = "hi";
      const redeployed = yield* deploy(EffectStack).pipe(
        Effect.ensuring(Effect.sync(() => delete process.env.AZURE_FN_EFFECT_GREETING)),
      );
      expect(redeployed.name).toBe(out.name);
      expect(yield* pollOk(`${out.url}/hello`).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("10 seconds"),
          until: (body) => body === "hi from azure",
          times: 12,
        }),
      )).toBe("hi from azure");

      expect(yield* roleAssignmentsOf(out.principalId!)).toEqual(before);
      // …and the bindings still work with them.
      yield* fetchOk(`${out.url}/blob/write?key=redeploy.txt&value=still-here`);
      expect(yield* fetchOk(`${out.url}/blob/read?key=redeploy.txt`)).toBe("still-here");
    }),
  { timeout: 900_000, exclusive: true },
);
