import * as Azure from "@alchemy.run/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as eventgrid from "@distilled.cloud/azure/eventgrid";
import * as storage from "@distilled.cloud/azure/storage";
import * as web from "@distilled.cloud/azure/web";
import * as Alchemy from "alchemy";
import { expect } from "alchemy-test";
import * as Output from "alchemy/Output";
import * as Test from "alchemy/Test/Alchemy";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { AsyncAppContainer, AsyncFunctionApp } from "./fixtures/async-function-app-stack.ts";
import EffectFunctionApp, { AppStorage } from "./fixtures/effect-function-app.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const where = (resourceGroupName: string, name: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return { subscriptionId, resourceGroupName, name };
  });

const getApp = (resourceGroupName: string, name: string) =>
  where(resourceGroupName, name).pipe(Effect.flatMap(web.GetWebApp));

const appSettingsOf = (resourceGroupName: string, name: string) =>
  where(resourceGroupName, name).pipe(
    Effect.flatMap(web.ListWebAppApplicationSettings),
    Effect.map((settings) => settings.properties ?? {}),
  );

const appGone = (resourceGroupName: string, name: string) =>
  getApp(resourceGroupName, name).pipe(
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

/** `scope|roleGuid` of every role assignment the principal holds. */
const roleAssignmentsOf = (principalId: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const page = yield* authorization.ListRoleAssignmentForSubscription({
      subscriptionId,
      _filter: `principalId eq '${principalId}'`,
    });
    return page.value
      .map(
        (a) =>
          `${a.properties?.scope?.toLowerCase()}|${a.properties?.roleDefinitionId?.split("/").pop()}`,
      )
      .sort();
  });

class NotReady extends Data.TaggedError("NotReady")<{ status: number; body: string }> {}

const getOk = (url: string, schedule: Schedule.Schedule<unknown>, times: number) =>
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
      Effect.retry({ schedule, times }),
    );
  });

/** `GET url` until 200, through cold start and role propagation (~4 min at most). */
const fetchOk = (url: string) => getOk(url, Schedule.exponential("1 second"), 8);

/** Poll `url` until 200: for side effects of event sources (5 min). */
const pollOk = (url: string) => getOk(url, Schedule.spaced("10 seconds"), 30);

/** A unique payload id per run (payloads, not resource names). */
const runId = (prefix: string) => `${prefix}${Date.now().toString(36)}`;

// ---------------------------------------------------------------------------
// Infrastructure only (no `main`)
// ---------------------------------------------------------------------------

/** Storage the Functions host and Flex deployments use. */
const storageProgram = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: "eastus",
  });
  const account = yield* Azure.Storage.StorageAccount("Storage", {
    resourceGroup: group.resourceGroupName,
  });
  const releases = yield* Azure.Storage.BlobContainer("Releases", {
    resourceGroup: group.resourceGroupName,
    storageAccount: account.storageAccountName,
  });
  const releasesV2 = yield* Azure.Storage.BlobContainer("ReleasesV2", {
    resourceGroup: group.resourceGroupName,
    storageAccount: account.storageAccountName,
  });
  return { group, account, releases, releasesV2 };
});

const connectionString = (resourceGroupName: string, accountName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const { keys } = yield* storage.ListStorageAccountKeys({
      subscriptionId,
      resourceGroupName,
      accountName,
    });
    const key = keys?.[0]?.value as string | Redacted.Redacted<string>;
    const value = Redacted.isRedacted(key) ? Redacted.value(key) : key;
    return `DefaultEndpointsProtocol=https;AccountName=${accountName};AccountKey=${value};EndpointSuffix=core.windows.net`;
  });

const program = (props: {
  connection: string;
  container: "releases" | "releasesV2";
  maximumInstanceCount: number;
  appSettings: Record<string, string>;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const { group, account, releases, releasesV2 } = yield* storageProgram;
    const plan = yield* Azure.Web.AppServicePlan("Plan", {
      resourceGroup: group.resourceGroupName,
      sku: "FC1",
    });
    const container = props.container === "releases" ? releases : releasesV2;
    const app = yield* Azure.Web.FunctionApp("Api", {
      resourceGroup: group.resourceGroupName,
      serverFarmId: plan.appServicePlanId,
      runtime: { name: "node", version: "20" },
      flexConsumption: {
        deploymentStorageUrl: Output.interpolate`${account.primaryEndpoints.blob}${container.containerName}`,
        deploymentStorageAuthentication: {
          type: "StorageAccountConnectionString",
          storageAccountConnectionStringName: "AzureWebJobsStorage",
        },
        maximumInstanceCount: props.maximumInstanceCount,
        instanceMemoryMB: 2048,
      },
      appSettings: {
        AzureWebJobsStorage: props.connection,
        ...props.appSettings,
      },
      tags: props.tags,
    });
    return { group, app, container };
  });

// Cost: ~$0 (Flex Consumption bills per execution; idle apps cost nothing,
// Standard_LRS storage is cents per month). Provisioning: ~2-4 minutes.
test.provider(
  "create, update, replace, and delete a flex consumption function app",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account } = yield* stack.deploy(storageProgram);
      const connection = yield* connectionString(
        group.resourceGroupName,
        account.storageAccountName,
      );

      const { app, container } = yield* stack.deploy(
        program({
          connection,
          container: "releases",
          maximumInstanceCount: 40,
          appSettings: { GREETING: "hello" },
          tags: { env: "test" },
        }),
      );
      expect(app.kind).toEqual("functionapp,linux");
      expect(app.siteName.length).toBeLessThanOrEqual(32);
      expect(app.defaultHostName).toEqual(`${app.siteName}.azurewebsites.net`);
      expect(app.codeHash).toBeUndefined();
      // No `main` and no bindings: no identity is added.
      expect(app.principalId).toBeUndefined();

      const observed = yield* getApp(group.resourceGroupName, app.siteName);
      const config = observed.properties?.functionAppConfig;
      expect(config?.runtime?.name).toEqual("node");
      expect(config?.runtime?.version).toEqual("20");
      expect(config?.scaleAndConcurrency?.maximumInstanceCount).toEqual(40);
      expect(config?.deployment?.storage?.value).toContain(container.containerName);
      expect(observed.tags?.env).toEqual("test");
      const settings = yield* appSettingsOf(group.resourceGroupName, app.siteName);
      expect(settings.GREETING).toEqual("hello");
      expect(settings.FUNCTIONS_WORKER_RUNTIME).toBeUndefined();
      expect(settings.ALCHEMY_STACK_NAME).toBeUndefined();

      // In-place update: scale limit (PUT-only), app settings, and tags.
      const updated = yield* stack.deploy(
        program({
          connection,
          container: "releases",
          maximumInstanceCount: 50,
          appSettings: { GREETING: "bonjour" },
          tags: { env: "prod" },
        }),
      );
      expect(updated.app.siteName).toEqual(app.siteName);
      const reobserved = yield* getApp(group.resourceGroupName, app.siteName);
      expect(
        reobserved.properties?.functionAppConfig?.scaleAndConcurrency?.maximumInstanceCount,
      ).toEqual(50);
      expect(reobserved.tags?.env).toEqual("prod");
      const resettings = yield* appSettingsOf(group.resourceGroupName, app.siteName);
      expect(resettings.GREETING).toEqual("bonjour");

      // Replacement: the deployment container cannot change in place.
      const replaced = yield* stack.deploy(
        program({
          connection,
          container: "releasesV2",
          maximumInstanceCount: 50,
          appSettings: { GREETING: "bonjour" },
          tags: { env: "prod" },
        }),
      );
      expect(replaced.app.siteName).not.toEqual(app.siteName);
      const moved = yield* getApp(group.resourceGroupName, replaced.app.siteName);
      expect(moved.properties?.functionAppConfig?.deployment?.storage?.value).toContain(
        replaced.container.containerName,
      );
      expect(yield* appGone(group.resourceGroupName, app.siteName)).toEqual("gone");

      yield* stack.destroy();
      expect(yield* appGone(group.resourceGroupName, replaced.app.siteName)).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 600_000,
  },
);

// ---------------------------------------------------------------------------
// Async form on a dedicated plan
// ---------------------------------------------------------------------------

// S1 Linux plan in westus2: ~$0.10/h, about $0.02 per run; ~5 min.
test.provider(
  "async function app on a dedicated plan serves fetch with literal, Config, secret, and resource env",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* AsyncFunctionApp;
          const container = yield* AsyncAppContainer;
          return {
            url: app.url,
            name: app.siteName,
            resourceGroup: app.resourceGroup,
            principalId: app.principalId,
            codeHash: app.codeHash,
            container: container.containerName,
          };
        }),
      );
      expect(out.codeHash).toMatch(/^[0-9a-f]{16}$/);

      // Out of band: Linux, Node.js 22 through linuxFxVersion, the classic
      // worker settings, identity-based host storage, and a system identity.
      const site = yield* getApp(out.resourceGroup, out.name);
      expect(site.kind).toEqual("functionapp,linux");
      expect(site.identity?.type).toEqual("SystemAssigned");
      expect(site.identity?.principalId).toEqual(out.principalId);
      const config = yield* where(out.resourceGroup, out.name).pipe(
        Effect.flatMap(web.GetWebAppConfiguration),
      );
      expect(config.properties?.linuxFxVersion?.toLowerCase()).toEqual("node|22");
      // Dedicated plan: the host stays loaded.
      expect(config.properties?.alwaysOn).toBe(true);
      const settings = yield* appSettingsOf(out.resourceGroup, out.name);
      expect(settings.FUNCTIONS_WORKER_RUNTIME).toEqual("node");
      expect(settings.FUNCTIONS_EXTENSION_VERSION).toEqual("~4");
      expect(settings.AzureWebJobsStorage__accountName).toMatch(/^[a-z0-9]{3,24}$/);
      expect(settings.AzureWebJobsStorage).toBeUndefined();
      // Kudu stores the package; the app mounts it.
      expect(settings.WEBSITE_RUN_FROM_PACKAGE).toEqual("1");

      // The host-storage roles went to the app's identity.
      const roles = yield* roleAssignmentsOf(out.principalId!);
      expect(roles.map((r) => r.split("|")[1]).sort()).toEqual(
        [
          Azure.Authorization.BuiltInRole.StorageBlobDataOwner,
          Azure.Authorization.BuiltInRole.StorageQueueDataContributor,
          "0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3",
        ].sort(),
      );

      const body = JSON.parse(yield* fetchOk(`${out.url}/greet?name=azure`)) as {
        message: string;
        secretLength: number;
        container: string;
        path: string;
        node: string;
      };
      expect(body.message).toEqual("hello azure");
      expect(body.secretLength).toEqual("s3cret".length);
      expect(body.container).toEqual(out.container);
      expect(body.path).toEqual("/greet");
      expect(body.node).toMatch(/^22\./);

      yield* stack.destroy();
      expect(yield* appGone(out.resourceGroup, out.name)).toEqual("gone");
      // Role assignments outlive their principal: the provider revoked them.
      // The list trails deletes by seconds.
      const remaining = yield* roleAssignmentsOf(out.principalId!).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (roles) => roles.length === 0,
          times: 12,
        }),
      );
      expect(remaining).toEqual([]);
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 900_000,
  },
);

// ---------------------------------------------------------------------------
// Effect form on Flex Consumption, shared across the cases below
// ---------------------------------------------------------------------------

const EffectStack = Alchemy.Stack(
  "AzureFunctionAppEffect",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const app = yield* EffectFunctionApp;
    const account = yield* AppStorage;
    return {
      url: app.url,
      name: app.siteName,
      resourceGroup: app.resourceGroup,
      principalId: app.principalId,
      eventSubscriptions: app.eventSubscriptions,
      storageAccountId: account.storageAccountId,
    };
  }),
);

// ~$0 (Flex Consumption bills per execution, Standard_LRS storage); ~5 min deploy.
const effect = beforeAll(deploy(EffectStack), { timeout: 900_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(EffectStack), { timeout: 600_000 });

test.provider(
  "effect function app serves fetch and registers one function per trigger",
  (_stack) =>
    Effect.gen(function* () {
      const out = yield* effect;
      expect(yield* fetchOk(`${out.url}/hello`)).toEqual("hello from a function app");

      const site = yield* getApp(out.resourceGroup, out.name);
      const config = site.properties?.functionAppConfig;
      expect(config?.runtime?.name).toEqual("node");
      expect(config?.runtime?.version).toEqual("22");
      expect(config?.deployment?.storage?.authentication?.type).toEqual("SystemAssignedIdentity");
      expect(site.tags?.fixture).toEqual("effect-function-app");

      const functions = yield* where(out.resourceGroup, out.name).pipe(
        Effect.flatMap(web.ListWebAppFunctions),
        Effect.map((page) =>
          (page.value ?? []).map((f) => (f.name ?? "").split("/").pop() ?? "").sort(),
        ),
        Effect.repeat({
          schedule: Schedule.spaced("10 seconds"),
          until: (names) => names.length >= 4,
          times: 12,
        }),
      );
      expect(functions).toEqual(
        ["blob-FnAppUploads", "http", "queue-FnAppJobs", "timer-minutely"].sort(),
      );

      // The blob-created source subscribed the storage account to the app.
      expect(out.eventSubscriptions.length).toEqual(1);
      const subscription = out.eventSubscriptions[0]!;
      expect(subscription.scope.toLowerCase()).toEqual(out.storageAccountId.toLowerCase());
      const observed = yield* eventgrid.GetEventSubscription({
        scope: subscription.scope,
        eventSubscriptionName: subscription.name,
      });
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
    }),
  { timeout: 600_000 },
);

test.provider(
  "BlobContainerReadWrite binding writes and reads a blob inside the function app",
  (_stack) =>
    Effect.gen(function* () {
      const out = yield* effect;
      const key = runId("binding/");
      const body = JSON.parse(yield* fetchOk(`${out.url}/blob?key=${key}&value=from-function-app`));
      expect(body).toEqual({ ok: true, result: { text: "from-function-app" } });
    }),
  { timeout: 600_000 },
);

test.provider(
  "Functions.schedule runs the handler on its schedule",
  (_stack) =>
    Effect.gen(function* () {
      const out = yield* effect;
      const since = Date.now() - 60_000;
      // The timer fires every minute; wait for a run after this test began.
      const recorded = yield* pollOk(`${out.url}/result?key=timer/last`).pipe(
        Effect.map((body) => JSON.parse(body) as { at: string; isPastDue: boolean }),
        Effect.repeat({
          schedule: Schedule.spaced("15 seconds"),
          until: (run) => Date.parse(run.at) >= since,
          times: 12,
        }),
      );
      expect(Date.parse(recorded.at)).toBeGreaterThanOrEqual(since);
      expect(recorded.isPastDue).toBe(false);
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
      expect(recorded.dequeueCount).toEqual(1);
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
  "redeploying the effect function app keeps its role assignments",
  (_stack) =>
    Effect.gen(function* () {
      const out = yield* effect;
      expect(out.principalId).toMatch(/^[0-9a-f-]{36}$/);
      const before = yield* roleAssignmentsOf(out.principalId!);
      // Host storage (3) + Results ReadWrite (1) + Uploads Write (1) + Jobs
      // send (1) + the queue source (2).
      expect(before.length).toEqual(8);

      // A changed env value updates the app in place.
      const config = yield* ConfigProvider.ConfigProvider;
      const redeployed = yield* deploy(EffectStack).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.orElse(
            ConfigProvider.fromEnv({ env: { AZURE_FNAPP_EFFECT_GREETING: "hi" } }),
            config,
          ),
        ),
      );
      expect(redeployed.name).toEqual(out.name);
      expect(
        yield* pollOk(`${out.url}/hello`).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("10 seconds"),
            until: (body) => body === "hi from a function app",
            times: 12,
          }),
        ),
      ).toEqual("hi from a function app");

      expect(yield* roleAssignmentsOf(out.principalId!)).toEqual(before);
      // …and the bindings still work with them.
      const key = runId("redeploy/");
      const body = JSON.parse(yield* fetchOk(`${out.url}/blob?key=${key}&value=still-here`));
      expect(body).toEqual({ ok: true, result: { text: "still-here" } });
    }),
  { timeout: 900_000 },
);
