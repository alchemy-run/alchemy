import { expect } from "bun:test";
import * as Azure from "@alchemy.run/azure";
import * as tables from "@distilled.cloud/azure/cosmos-tables";
import * as resources from "@distilled.cloud/azure/resources";
import * as storage from "@distilled.cloud/azure/storage";
import * as web from "@distilled.cloud/azure/web";
import * as Alchemy from "alchemy";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Test from "alchemy/Test/Bun";
import * as Effect from "effect/Effect";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import Stack from "../alchemy.run.ts";
import { JobApi } from "../src/JobApi.ts";
import { JOB_PARTITION } from "../src/resources.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE,
});

/** The deployer's credentials, for out-of-band ARM and Table storage reads. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

// One Flex Consumption app (billed per execution) and two Standard_LRS
// storage accounts: about $0.01 per run. Deploying takes about 5 minutes.
const stack = beforeAll(deploy(Stack), { timeout: 900_000 });

const baseUrl = Effect.map(stack, ({ url }) => String(url).replace(/\/+$/, ""));

/** A typed client derived from the same `JobApi` the Function serves. */
const client = Effect.gen(function* () {
  const url = yield* baseUrl;
  return yield* HttpApiClient.make(JobApi, { baseUrl: url });
});

/**
 * Retry through the Flex Consumption cold start (404/503 until the app's
 * functions are indexed) and the table role propagating after the first
 * deploy (`JobStoreUnavailable` with `TablePermissionDenied`). A
 * `JobNotFound` is an answer, not a transient failure.
 */
const settled = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.tapError((error) =>
      error._tag === "JobNotFound" ? Effect.void : Effect.logWarning(`retrying: ${error._tag}`),
    ),
    Effect.retry({
      schedule: Schedule.spaced("5 seconds"),
      times: 48,
      while: (error) => error._tag !== "JobNotFound",
    }),
  );

/** Where the example's resources are, from the stack outputs. */
const where = Effect.gen(function* () {
  const outputs = yield* stack;
  const { subscriptionId } = yield* Azure.AzureEnvironment.current.pipe(Effect.provide(azure));
  return { subscriptionId, ...outputs };
});

type Where = Effect.Success<typeof where>;

/** Table endpoint signed with an account SAS, so reads do not use the Function's identity. */
const sasEndpoint = (ids: Where) =>
  storage
    .ListStorageAccountAccountSAS({
      subscriptionId: ids.subscriptionId,
      resourceGroupName: ids.resourceGroup,
      accountName: ids.storageAccount,
      signedServices: "t",
      signedResourceTypes: "sco",
      signedPermission: "rl",
      signedProtocol: "https",
      signedExpiry: new Date(Date.now() + 3_600_000).toISOString(),
    })
    .pipe(
      Effect.map(
        ({ accountSasToken }) =>
          `https://${ids.storageAccount}.table.core.windows.net/?${accountSasToken}`,
      ),
      Effect.provide(azure),
    );

/** The job's entity as Table storage holds it, read out of band. */
const entityOf = (ids: Where, id: string) =>
  Effect.gen(function* () {
    const url = yield* sasEndpoint(ids);
    return yield* tables
      .TableQueryEntityWithPartitionAndRowKey({
        url,
        table: ids.table,
        partitionKey: JOB_PARTITION,
        rowKey: id,
      })
      .pipe(
        Effect.map((entity) => entity as Record<string, unknown>),
        Effect.catchTag("TableEntityNotFound", () => Effect.succeed(undefined)),
        Effect.provide(azure),
      );
  });

const found = Effect.as("found" as const);
const gone = () => Effect.succeed("gone" as const);

const functionAppStatus = (ids: Where) =>
  web
    .GetWebApp({
      subscriptionId: ids.subscriptionId,
      resourceGroupName: ids.resourceGroup,
      name: ids.functionAppName,
    })
    .pipe(found, Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], gone));

const tableStatus = (ids: Where) =>
  storage
    .GetTable({
      subscriptionId: ids.subscriptionId,
      resourceGroupName: ids.resourceGroup,
      accountName: ids.storageAccount,
      tableName: ids.table,
    })
    .pipe(found, Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], gone));

const storageAccountStatus = (ids: Where) =>
  storage
    .GetStorageAccountProperties({
      subscriptionId: ids.subscriptionId,
      resourceGroupName: ids.resourceGroup,
      accountName: ids.storageAccount,
    })
    .pipe(found, Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], gone));

const resourceGroupStatus = (ids: Where) =>
  resources
    .GetResourceGroup({
      subscriptionId: ids.subscriptionId,
      resourceGroupName: ids.resourceGroup,
    })
    .pipe(found, Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], gone));

/** Poll until a deleted resource reads as gone. */
const untilGone = <E, R>(status: Effect.Effect<"found" | "gone", E, R>) =>
  status.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (current) => current === "gone",
      times: 24,
    }),
    Effect.provide(azure),
  );

afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    const ids = yield* where;
    yield* destroy(Stack);
    expect(yield* untilGone(functionAppStatus(ids))).toBe("gone");
    expect(yield* untilGone(tableStatus(ids))).toBe("gone");
    expect(yield* untilGone(storageAccountStatus(ids))).toBe("gone");
    // The stack's resource group, `AzureFunctionHttpApiExample-<stage>`.
    expect(yield* untilGone(resourceGroupStatus(ids))).toBe("gone");
  }),
  { timeout: 600_000 },
);

test(
  "deploys the function app and the job table",
  Effect.gen(function* () {
    const ids = yield* where;
    expect(String(ids.url)).toMatch(/^https:\/\/.+\.azurewebsites\.net/);
    expect(yield* functionAppStatus(ids).pipe(Effect.provide(azure))).toBe("found");
    expect(yield* tableStatus(ids).pipe(Effect.provide(azure))).toBe("found");
  }),
  { timeout: 120_000 },
);

test(
  "serves the health endpoint",
  Effect.gen(function* () {
    const api = yield* client;
    expect(yield* settled(api.Jobs.health())).toBe("ok");
  }),
  { timeout: 300_000 },
);

test(
  "creates, reads, lists, and deletes a job in Table storage",
  Effect.gen(function* () {
    const ids = yield* where;
    const api = yield* client;
    const content = "render the quarterly report";

    const created = yield* settled(api.Jobs.createJob({ payload: { content } }));
    expect(created.content).toBe(content);
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);

    // The API wrote a real Table storage entity.
    const entity = yield* entityOf(ids, created.id);
    expect({ content: entity?.content, createdAt: entity?.createdAt }).toEqual({
      content,
      createdAt: created.createdAt,
    });

    expect(yield* settled(api.Jobs.getJob({ params: { id: created.id } }))).toEqual(created);

    const listed = yield* settled(api.Jobs.listJobs());
    expect(listed.map((job) => job.id)).toContain(created.id);

    yield* settled(api.Jobs.deleteJob({ params: { id: created.id } }));
    expect(yield* entityOf(ids, created.id)).toBeUndefined();

    const missing = yield* settled(api.Jobs.getJob({ params: { id: created.id } })).pipe(
      Effect.flip,
    );
    expect(missing).toMatchObject({ _tag: "JobNotFound", id: created.id });
  }),
  { timeout: 300_000 },
);

test(
  "answers 400 for a bad payload and 404 for an unknown job",
  Effect.gen(function* () {
    const url = yield* baseUrl;
    const api = yield* client;
    yield* settled(api.Jobs.health());

    const invalid = yield* HttpClient.execute(
      HttpClientRequest.post(`${url}/jobs`).pipe(HttpClientRequest.bodyJsonUnsafe({ content: 42 })),
    );
    expect(invalid.status).toBe(400);

    // Wait out role propagation on this instance, then read the raw 404.
    yield* settled(api.Jobs.getJob({ params: { id: "unknown-job" } })).pipe(Effect.flip);
    const unknown = yield* HttpClient.execute(HttpClientRequest.get(`${url}/jobs/unknown-job`));
    expect(unknown.status).toBe(404);
    expect(yield* unknown.json).toEqual({ _tag: "JobNotFound", id: "unknown-job" });
  }),
  { timeout: 300_000 },
);
