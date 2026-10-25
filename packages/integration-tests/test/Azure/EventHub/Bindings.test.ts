import * as Azure from "@alchemy.run/azure";
import { Credentials } from "@distilled.cloud/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import EventHubBindingsFunction, {
  BasicTelemetry,
  Data,
  Received,
  Telemetry,
} from "./fixtures/function.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

/** Object ID of the deployer's service principal (the `oid` claim of its ARM token). */
const deployerObjectId = Effect.gen(function* () {
  const credentials = yield* Credentials;
  const config = yield* credentials;
  const token = Redacted.value(config.bearerToken);
  return yield* Effect.sync(
    () =>
      JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"))
        .oid as string,
  );
});

const Stack = Alchemy.Stack(
  "AzureEventHubBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* EventHubBindingsFunction;
    const hub = yield* Telemetry;
    const basicHub = yield* BasicTelemetry;
    const account = yield* Data;
    const received = yield* Received;
    // The deployer reads what the trigger received, out of band.
    const deployer = yield* deployerObjectId.pipe(Effect.orDie);
    yield* Azure.Authorization.RoleAssignment("EhBindingsDeployerReader", {
      scope: received.containerId,
      roleDefinitionId: Azure.Authorization.BuiltInRole.StorageBlobDataReader,
      principalId: deployer,
      principalType: "ServicePrincipal",
    });
    return {
      url: fn.url,
      principalId: fn.principalId,
      hubId: hub.eventHubId,
      basicHubId: basicHub.eventHubId,
      account: account.storageAccountName,
      container: received.containerName,
    };
  }),
);

// ~$0.03/run (Event Hubs Standard + Basic, Flex Consumption Function, Standard_LRS account, ~15 min); ~6 min deploy.
const stack = beforeAll(deploy(Stack), { timeout: 900_000 });

/** Azure credentials and environment for hooks and out-of-band checks. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

type Body = { ok: boolean; result?: unknown; tag?: string; error?: string };

/** What the trigger recorded for one event. */
type ReceivedEvent = {
  partitionId: string | null;
  partitionKey: string | null;
  properties: { [key: string]: unknown } | null;
  systemProperties: { [key: string]: unknown } | null;
  metadataKeys: string[];
};

const outputs = Effect.gen(function* () {
  const out = yield* stack;
  return {
    url: out.url as string,
    principalId: out.principalId as string,
    hubId: out.hubId as string,
    basicHubId: out.basicHubId as string,
    account: out.account as string,
    container: out.container as string,
  };
});

/**
 * GET a fixture route until it answers 200 and Event Hubs accepts the host's
 * token (role propagation answers `MessagingUnauthorized`; up to 9 minutes,
 * through the Flex Consumption cold start), then return the answer so a
 * typed failure can be asserted.
 */
const get = (path: string) =>
  Effect.gen(function* () {
    const { url } = yield* outputs;
    return yield* HttpClient.get(`${url}${path}`).pipe(
      Effect.timeout("60 seconds"),
      Effect.filterOrFail(
        (response) => response.status === 200,
        (response) => `status ${response.status}`,
      ),
      Effect.flatMap((response) => response.json),
      Effect.map((body) => body as Body),
      Effect.flatMap((body) =>
        !body.ok && body.tag === "MessagingUnauthorized" ? Effect.fail(body) : Effect.succeed(body),
      ),
      // Azure documents up to 10 minutes for a role assignment to take effect.
      Effect.retry({ schedule: Schedule.spaced("10 seconds"), times: 54 }),
    );
  });

const expectOk = (body: Body) =>
  expect({ ok: body.ok, tag: body.tag, error: body.error }).toEqual({
    ok: true,
    tag: undefined,
    error: undefined,
  });

const expectTag = (body: Body, tag: string) =>
  expect({ ok: body.ok, tag: body.tag }).toEqual({ ok: false, tag });

/** Typed tags while the trigger has not written the record or the deployer's role propagates. */
const PENDING = new Set([
  "BlobNotFound",
  "SchemaRegistryStorageAccessDenied",
  "StorageAuthorizationFailure",
]);

/** Read, as the deployer, what the Event Hubs trigger recorded for event `id`. */
const receivedEvent = (id: string) =>
  Effect.gen(function* () {
    const { account, container } = yield* outputs;
    const res = yield* blob
      .DownloadBlob({
        url: `https://${account}.blob.core.windows.net`,
        containerName: container,
        blob: `events/${id}`,
      })
      .pipe(
        Effect.retry({
          while: (e) => PENDING.has(e._tag),
          schedule: Schedule.spaced("10 seconds"),
          times: 36,
        }),
        Effect.provide(azure),
      );
    return JSON.parse(new TextDecoder().decode(res.body)) as ReceivedEvent;
  });

const assignmentsOf = (principalId: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const page = yield* authorization.ListRoleAssignmentForSubscription({
      subscriptionId,
      _filter: `principalId eq '${principalId}'`,
    });
    return page.value.map(
      (a) =>
        `${a.properties?.roleDefinitionId?.split("/").pop()} ${a.properties?.scope?.toLowerCase()}`,
    );
  });

/** Azure Event Hubs Data Receiver, granted by the trigger (`Azure.Functions.EventHubEventSource`). */
const EVENT_HUBS_DATA_RECEIVER = "a638d3c7-ab3a-418d-83e6-5f17a39d4fde";

describe("Event Hubs bindings on an Azure Function", { tags: ["provider:azure", "live"] }, () => {
  describe("SendEvent", () => {
    test(
      "sends an event with a partition key and custom properties",
      Effect.gen(function* () {
        expectOk(yield* get("/op/SendEvent?id=op-event&partitionKey=pk-event&source=op"));
        const event = yield* receivedEvent("op-event");
        // Single-event sends also carry unreserved HTTP headers (`traceparent`, …) as properties.
        expect({ partitionKey: event.partitionKey, source: event.properties?.source }).toEqual({
          partitionKey: "pk-event",
          source: "op",
        });
      }),
      { timeout: 900_000 },
    );

    test(
      "fails an event over the 1 MB Standard limit with MessageTooLarge",
      Effect.gen(function* () {
        expectTag(yield* get("/op/SendEvent/too-large"), "MessageTooLarge");
      }),
      { timeout: 600_000 },
    );
  });

  describe("SendEventBatch", () => {
    test(
      "sends a batch that lands in one partition",
      Effect.gen(function* () {
        expectOk(
          yield* get(
            "/op/SendEventBatch?ids=op-batch-a,op-batch-b&partitionKey=pk-batch&source=batch",
          ),
        );
        const a = yield* receivedEvent("op-batch-a");
        const b = yield* receivedEvent("op-batch-b");
        expect(a.partitionId).toMatch(/^[01]$/);
        expect([a, b].map((e) => [e.partitionId, e.partitionKey, e.properties])).toEqual([
          [a.partitionId, "pk-batch", { source: "batch" }],
          [a.partitionId, "pk-batch", { source: "batch" }],
        ]);
      }),
      { timeout: 900_000 },
    );

    test(
      "fails a batch with different partition keys with BatchPartitionKeyMismatch",
      Effect.gen(function* () {
        expectTag(
          yield* get("/op/SendEventBatch/mismatch?ids=mismatch-a,mismatch-b"),
          "BatchPartitionKeyMismatch",
        );
      }),
      { timeout: 600_000 },
    );
  });

  describe("SendPartitionEvent", () => {
    test(
      "sends an event to partition 1",
      Effect.gen(function* () {
        expectOk(yield* get("/op/SendPartitionEvent?id=op-partition&partitionId=1"));
        const event = yield* receivedEvent("op-partition");
        expect(event.partitionId).toBe("1");
      }),
      { timeout: 900_000 },
    );

    test(
      "fails a partition the hub does not have with InvalidPartition",
      Effect.gen(function* () {
        expectTag(
          yield* get("/op/SendPartitionEvent?id=op-bad-partition&partitionId=7"),
          "InvalidPartition",
        );
      }),
      { timeout: 600_000 },
    );
  });

  describe("SendPublisherEvent", () => {
    test(
      "sends an event under a publisher name",
      Effect.gen(function* () {
        expectOk(yield* get("/op/SendPublisherEvent?id=op-publisher&publisherId=device-1"));
        const event = yield* receivedEvent("op-publisher");
        expect(event.partitionId).toMatch(/^[01]$/);
      }),
      { timeout: 900_000 },
    );

    test(
      "fails on a Basic namespace with PublisherRequiresStandardTier",
      Effect.gen(function* () {
        expectTag(
          yield* get("/op/SendPublisherEvent/basic?id=op-basic&publisherId=device-1"),
          "PublisherRequiresStandardTier",
        );
      }),
      { timeout: 600_000 },
    );
  });

  describe("Send", () => {
    test(
      "sends one event, a batch, to a partition, and as a publisher",
      Effect.gen(function* () {
        expectOk(yield* get("/send/send?id=client-send&partitionKey=pk-client&source=client"));
        expectOk(yield* get("/send/batch?ids=client-batch-a,client-batch-b&source=client-batch"));
        expectOk(yield* get("/send/partition?id=client-partition&partitionId=0"));
        expectOk(yield* get("/send/publisher?id=client-publisher&publisherId=device-2"));

        const single = yield* receivedEvent("client-send");
        expect({ partitionKey: single.partitionKey, source: single.properties?.source }).toEqual({
          partitionKey: "pk-client",
          source: "client",
        });
        const batchA = yield* receivedEvent("client-batch-a");
        const batchB = yield* receivedEvent("client-batch-b");
        expect([batchA.properties, batchB.properties]).toEqual([
          { source: "client-batch" },
          { source: "client-batch" },
        ]);
        const partition = yield* receivedEvent("client-partition");
        expect(partition.partitionId).toBe("0");
        const publisher = yield* receivedEvent("client-publisher");
        expect(publisher.partitionId).toMatch(/^[01]$/);
      }),
      { timeout: 900_000 },
    );
  });

  describe("least privilege", () => {
    test.provider(
      "assigns only Azure Event Hubs Data Sender (send only) on each bound event hub",
      (_stack) =>
        Effect.gen(function* () {
          const { principalId, hubId, basicHubId } = yield* outputs;
          expect(principalId).toMatch(/^[0-9a-f-]{36}$/);
          const hub = hubId.toLowerCase();
          const basicHub = basicHubId.toLowerCase();
          const onHubs = (yield* assignmentsOf(principalId)).filter((a) =>
            a.includes("/eventhubs/"),
          );
          expect(onHubs.sort()).toEqual(
            [
              `${Azure.Authorization.BuiltInRole.EventHubsDataSender} ${hub}`,
              `${EVENT_HUBS_DATA_RECEIVER} ${hub}`,
              `${Azure.Authorization.BuiltInRole.EventHubsDataSender} ${basicHub}`,
            ].sort(),
          );
          const { subscriptionId } = yield* Azure.AzureEnvironment.current;
          const sender = yield* authorization.GetRoleDefinition({
            scope: `/subscriptions/${subscriptionId}`,
            roleDefinitionId: Azure.Authorization.BuiltInRole.EventHubsDataSender,
          });
          const permissions = sender.properties?.permissions ?? [];
          expect({
            actions: permissions.flatMap((p) => p.actions ?? []),
            dataActions: permissions.flatMap((p) => p.dataActions ?? []),
          }).toEqual({
            actions: ["Microsoft.EventHub/*/eventhubs/read"],
            dataActions: ["Microsoft.EventHub/*/send/action"],
          });
        }),
      { timeout: 120_000 },
    );
  });
});

// Destroy, then prove every role assigned to the Function's identity is gone.
afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    const { principalId } = yield* stack;
    yield* destroy(Stack);
    expect(principalId).toMatch(/^[0-9a-f-]{36}$/);
    const remaining = yield* assignmentsOf(principalId!).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("5 seconds"),
        until: (assignments) => assignments.length === 0,
        times: 12,
      }),
    );
    expect(remaining).toEqual([]);
  }).pipe(Effect.provide(azure)),
  { timeout: 900_000 },
);
