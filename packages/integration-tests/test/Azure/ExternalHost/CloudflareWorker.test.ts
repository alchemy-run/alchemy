import * as Azure from "@alchemy.run/azure";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as servicebus from "@distilled.cloud/azure/servicebus";
import * as applications from "@distilled.cloud/microsoft-graph/applications";
import * as servicePrincipals from "@distilled.cloud/microsoft-graph/servicePrincipals";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import ExternalHostWorker, {
  Container,
  Jobs,
  Orders,
  SECRET_VALUE,
  Secret,
  Telemetry,
} from "./fixtures/worker.ts";

const providers = Layer.mergeAll(Azure.providers(), Cloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const STACK = "AzureExternalHostStack";

const Stack = Alchemy.Stack(
  STACK,
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* ExternalHostWorker;
    const container = yield* Container;
    const jobs = yield* Jobs;
    const secret = yield* Secret;
    const orders = yield* Orders;
    const telemetry = yield* Telemetry;
    return {
      url: worker.url.as<string>(),
      containerId: container.containerId,
      jobsQueueId: jobs.queueId,
      secretId: secret.secretId,
      ordersQueueId: orders.queueId,
      ordersQueue: orders.queueName,
      busNamespace: orders.namespaceName,
      resourceGroup: orders.resourceGroup,
      telemetryId: telemetry.eventHubId,
    };
  }),
);

const stack = beforeAll(deploy(Stack), { timeout: 600_000 });

/** Azure credentials, Graph credentials and the environment, for hooks (tests get them from `test.provider`). */
const azure = Layer.mergeAll(
  Azure.environmentFromAuthProvider(),
  Azure.fromAuthProvider(),
  Azure.graphFromAuthProvider(),
).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

type Body = { ok: boolean; result?: any; error?: string };

// A fresh workers.dev URL, the new client secret, and the role assignments
// all take a while to propagate: retry until the route answers `ok`, then
// report the last answer so a real failure shows its Azure error.
const call = (route: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    return yield* HttpClient.get(`${url}${route}`).pipe(
      Effect.timeout("30 seconds"),
      Effect.flatMap((response) => response.json),
      Effect.map((body) => body as Body),
      Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 36 }),
      Effect.catch((body) => Effect.succeed(body as Body)),
    );
  });

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

/** The service principal Alchemy created for the Worker, found by its ownership tags. */
const workerPrincipalId = Effect.gen(function* () {
  const page = yield* applications.listApplication({
    filter: "tags/any(t:t eq 'alchemy::id=AzureExternalHostWorkerAzureIdentity')",
  });
  const app = page.value.find((a) => (a.tags ?? []).includes(`alchemy::stack=${STACK}`));
  if (app === undefined) return undefined;
  const principal = yield* servicePrincipals.getServicePrincipalByAppId({ appId: app.appId! });
  return { applicationObjectId: app.id!, principalId: principal.id! };
});

const assignmentsOf = (principalId: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const page = yield* authorization.ListRoleAssignmentForSubscription({
      subscriptionId,
      _filter: `principalId eq '${principalId}'`,
    });
    return page.value.map((a) => ({
      role: a.properties?.roleDefinitionId?.split("/").pop(),
      scope: a.properties?.scope?.toLowerCase(),
    }));
  });

describe(
  "Azure bindings on a Cloudflare Worker",
  { tags: ["provider:azure", "provider:cloudflare", "live"] },
  () => {
    describe("Storage.BlobContainerReadWrite", () => {
      test(
        "puts, gets, heads, and lists a blob",
        Effect.gen(function* () {
          const body = yield* call("/blob/read-write?key=rw-roundtrip");
          expectOk(body);
          expect(body.result).toEqual({
            text: "from-worker",
            size: "from-worker".length,
            contentType: "text/plain",
            keys: ["rw-roundtrip"],
          });
        }),
        { timeout: 240_000 },
      );
    });

    describe("Storage.BlobContainerWrite", () => {
      test(
        "uploads bytes and deletes a blob",
        Effect.gen(function* () {
          const written = yield* call("/blob/write?key=write-only");
          expectOk(written);
          expect(written.result.etag).toBeTruthy();
          const deleted = yield* call("/blob/delete?key=write-only");
          expectOk(deleted);
          expect(deleted.result).toEqual({ gone: true });
        }),
        { timeout: 240_000 },
      );
    });

    describe("Storage.BlobContainerRead", () => {
      test(
        "reads a blob and reports missing blobs as undefined",
        Effect.gen(function* () {
          expectOk(yield* call("/blob/write?key=read-only"));
          const body = yield* call("/blob/read?key=read-only");
          expectOk(body);
          expect(body.result).toEqual({ text: "bytes", missing: true, missingHead: true });
        }),
        { timeout: 240_000 },
      );
    });

    describe("Storage.QueueSend + Storage.QueueReceive", () => {
      test(
        "enqueues, receives, and deletes a message",
        Effect.gen(function* () {
          const body = yield* call("/queue?key=queue-roundtrip");
          expectOk(body);
          expect(body.result.messageId).toBeTruthy();
          expect(body.result.texts).toContain("queue-roundtrip");
        }),
        { timeout: 240_000 },
      );
    });

    describe("KeyVault.SecretRead", () => {
      test(
        "reads the secret value",
        Effect.gen(function* () {
          const body = yield* call("/secret");
          expectOk(body);
          expect(body.result).toEqual({ value: SECRET_VALUE });
        }),
        { timeout: 240_000 },
      );
    });

    describe("ServiceBus.QueueSend", () => {
      // `test.provider` supplies the Azure credentials for the out-of-band read.
      test.provider(
        "sends a message the queue then holds",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/servicebus?key=sb-message");
            expectOk(body);
            const { ordersQueue, busNamespace, resourceGroup } = yield* stack;
            const { subscriptionId } = yield* Azure.AzureEnvironment.current;
            const queue = yield* servicebus
              .GetQueue({
                subscriptionId,
                resourceGroupName: resourceGroup!,
                namespaceName: busNamespace!,
                queueName: ordersQueue!,
              })
              .pipe(
                Effect.repeat({
                  schedule: Schedule.spaced("5 seconds"),
                  until: (q) => (q.properties?.messageCount ?? 0) > 0,
                  times: 12,
                }),
              );
            expect(queue.properties?.messageCount).toBeGreaterThan(0);
          }),
        { timeout: 240_000 },
      );
    });

    describe("EventHub.Send", () => {
      test(
        "sends one event and a batch",
        Effect.gen(function* () {
          const body = yield* call("/eventhub?key=eh-event");
          expectOk(body);
          expect(body.result).toEqual({ sent: 3 });
        }),
        { timeout: 240_000 },
      );
    });

    describe("AzureBindings.Bind", () => {
      test.provider(
        "assigns each binding's role to the Worker's service principal, scoped to the resource",
        (_stack) =>
          Effect.gen(function* () {
            const outputs = yield* stack;
            const identity = yield* workerPrincipalId;
            expect(identity).not.toBeUndefined();
            const assignments = yield* assignmentsOf(identity!.principalId);
            const BuiltInRole = Azure.Authorization.BuiltInRole;
            const container = outputs.containerId!.toLowerCase();
            const jobs = outputs.jobsQueueId!.toLowerCase();
            expect(assignments.map((a) => `${a.role} ${a.scope}`).sort()).toEqual(
              [
                `${BuiltInRole.StorageBlobDataReader} ${container}`,
                `${BuiltInRole.StorageBlobDataContributor} ${container}`,
                `${BuiltInRole.StorageBlobDataContributor} ${container}`,
                `${BuiltInRole.StorageQueueDataMessageSender} ${jobs}`,
                `${BuiltInRole.StorageQueueDataMessageProcessor} ${jobs}`,
                `${BuiltInRole.KeyVaultSecretsUser} ${outputs.secretId!.toLowerCase()}`,
                `${BuiltInRole.ServiceBusDataSender} ${outputs.ordersQueueId!.toLowerCase()}`,
                `${BuiltInRole.EventHubsDataSender} ${outputs.telemetryId!.toLowerCase()}`,
              ].sort(),
            );
          }),
        { timeout: 120_000 },
      );
    });
  },
);

// Destroy, then prove the Worker's Entra identity and every role assigned
// to it are gone.
afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    const identity = yield* workerPrincipalId;
    yield* destroy(Stack);
    expect(identity).not.toBeUndefined();
    const remaining = yield* assignmentsOf(identity!.principalId).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("5 seconds"),
        until: (assignments) => assignments.length === 0,
        times: 12,
      }),
    );
    expect(remaining).toEqual([]);
    const app = yield* applications
      .getApplication({ applicationId: identity!.applicationObjectId })
      .pipe(
        Effect.as("found" as const),
        Effect.catchTag("ResourceNotFound", () => Effect.succeed("gone" as const)),
        Effect.repeat({
          schedule: Schedule.spaced("3 seconds"),
          until: (status) => status === "gone",
          times: 40,
        }),
      );
    expect(app).toEqual("gone");
  }).pipe(Effect.provide(azure)),
  { timeout: 900_000 },
);
