import * as Azure from "@alchemy.run/azure";
import * as app from "@distilled.cloud/azure/app";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as acr from "@distilled.cloud/azure/containerregistry-data";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { withManagedEnvironment } from "../gates.ts";
import {
  APP_LOCATION,
  AppAudit,
  AppEnvironment,
  AppJobs,
  AppOrders,
} from "./fixtures/app-resources.ts";
import { AsyncApp, AsyncAppContainer } from "./fixtures/async-app-stack.ts";
import EffectApp from "./fixtures/effect-app.ts";
import { logLevel, QUICKSTART_IMAGE, waitGone } from "./fixtures/shared.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

const getApp = (resourceGroupName: string, containerAppName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* app.GetContainerApp({
      subscriptionId,
      resourceGroupName,
      containerAppName,
    });
  });

const listSecrets = (resourceGroupName: string, containerAppName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* app.ListContainerAppSecrets({
      subscriptionId,
      resourceGroupName,
      containerAppName,
    });
  });

const program = (props: {
  environmentId: string;
  name?: string;
  greeting: string;
  secret: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: APP_LOCATION,
    });
    const api = yield* Azure.ContainerApps.ContainerApp("Api", {
      resourceGroup: group.resourceGroupName,
      name: props.name,
      location: APP_LOCATION,
      environmentId: props.environmentId,
      configuration: {
        ingress: { external: true, targetPort: 80 },
      },
      secrets: [{ name: "api-key", value: Redacted.make(props.secret) }],
      template: {
        containers: [
          {
            name: "api",
            image: QUICKSTART_IMAGE,
            resources: { cpu: 0.25, memory: "0.5Gi" },
            env: [
              { name: "GREETING", value: props.greeting },
              { name: "API_KEY", secretRef: "api-key" },
            ],
          },
        ],
        scale: { minReplicas: 0, maxReplicas: 1 },
      },
      tags: props.tags,
    });
    return { group, api };
  });

// Runs in the shared runtime environment below (Express environments fail
// to register in eastus: ExpressEnvironmentRegistrationError). Cost: a
// 0.25 vCPU app that scales to zero (~$0). Time: ~5 minutes after the
// environment is up.
test.provider(
  "create, update, replace, and delete a container app",
  (stack) =>
    Effect.gen(function* () {
      const { environmentId } = yield* runtime;
      yield* stack.destroy();

      const { group, api } = yield* stack.deploy(
        program({ environmentId, greeting: "hello", secret: "one", tags: { env: "test" } }),
      );
      expect(api.containerAppName).toMatch(/^[a-z][a-z0-9-]{1,31}$/);
      expect(api.fqdn).toContain("azurecontainerapps.io");
      expect(api.url).toEqual(`https://${api.fqdn}`);
      expect(api.latestRevisionName).toMatch(new RegExp(`^${api.containerAppName}--[a-z0-9]+$`));

      const observed = yield* getApp(group.resourceGroupName, api.containerAppName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(
        observed.properties?.template?.containers?.[0]?.env?.find((e) => e.name === "GREETING")
          ?.value,
      ).toEqual("hello");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Api");
      const secrets = yield* listSecrets(group.resourceGroupName, api.containerAppName);
      expect(secrets.value.find((s) => s.name === "api-key")?.value).toEqual("one");

      // The quickstart image answers on the public ingress.
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get(api.url ?? "").pipe(
        Effect.flatMap((res) =>
          res.status === 200 ? Effect.succeed(res) : Effect.fail(res.status),
        ),
        Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
      );
      expect(response.status).toEqual(200);

      // In-place update: env var (new revision), secret value, and tags.
      const updated = yield* stack.deploy(
        program({ environmentId, greeting: "goodbye", secret: "two", tags: { env: "prod" } }),
      );
      expect(updated.api.containerAppId).toEqual(api.containerAppId);
      const reobserved = yield* getApp(group.resourceGroupName, api.containerAppName);
      expect(
        reobserved.properties?.template?.containers?.[0]?.env?.find((e) => e.name === "GREETING")
          ?.value,
      ).toEqual("goodbye");
      expect(reobserved.tags?.env).toEqual("prod");
      const resecrets = yield* listSecrets(group.resourceGroupName, api.containerAppName);
      expect(resecrets.value.find((s) => s.name === "api-key")?.value).toEqual("two");

      // Replacement: a new name creates a new app; the environment stays.
      const replaced = yield* stack.deploy(
        program({
          environmentId,
          name: `${api.containerAppName.slice(0, 28).replace(/-+$/, "")}-two`,
          greeting: "goodbye",
          secret: "two",
          tags: { env: "prod" },
        }),
      );
      expect(replaced.api.containerAppName).not.toEqual(api.containerAppName);
      expect(yield* waitGone(getApp(group.resourceGroupName, api.containerAppName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(
        yield* waitGone(getApp(group.resourceGroupName, replaced.api.containerAppName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:containerapps", "live"],
    timeout: 900_000,
  },
);

// ── Runtime: the Effect and async forms in one shared environment ──────────

class NotReady extends Data.TaggedError("NotReady")<{ status: number; body: string }> {}

/** `GET url` until it answers 200, through cold starts and role propagation (~4 min). */
const fetchOk = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(url).pipe(
      // A request to an app with no ready replica waits for one: bound it.
      Effect.timeout("30 seconds"),
      Effect.flatMap((res) =>
        Effect.flatMap(res.text, (body) =>
          res.status === 200
            ? Effect.succeed(body)
            : Effect.fail(new NotReady({ status: res.status, body: body.slice(0, 300) })),
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
      // A request to an app with no ready replica waits for one: bound it.
      Effect.timeout("30 seconds"),
      Effect.flatMap((res) =>
        Effect.flatMap(res.text, (body) =>
          res.status === 200
            ? Effect.succeed(body)
            : Effect.fail(new NotReady({ status: res.status, body: body.slice(0, 300) })),
        ),
      ),
      Effect.mapError((e) =>
        e._tag === "NotReady" ? e : new NotReady({ status: 0, body: String(e) }),
      ),
      Effect.retry({ schedule: Schedule.spaced("10 seconds"), times: 30 }),
    );
  });

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

const RuntimeStack = Alchemy.Stack(
  "AzureContainerAppRuntime",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const environment = yield* AppEnvironment;
    const effectApp = yield* EffectApp;
    const asyncApp = yield* AsyncApp;
    const container = yield* AsyncAppContainer;
    const jobs = yield* AppJobs;
    const orders = yield* AppOrders;
    const audit = yield* AppAudit;
    return {
      effect: {
        url: effectApp.url,
        name: effectApp.containerAppName,
        resourceGroup: effectApp.resourceGroup,
        principalId: effectApp.principalId,
        image: effectApp.image,
        codeHash: effectApp.codeHash,
      },
      async: {
        url: asyncApp.url,
        name: asyncApp.containerAppName,
        resourceGroup: asyncApp.resourceGroup,
        image: asyncApp.image,
        codeHash: asyncApp.codeHash,
        container: container.containerName,
      },
      environmentId: environment.environmentId,
      jobsQueueId: jobs.queueId,
      ordersQueueId: orders.queueId,
      auditId: audit.subscriptionResourceId,
    };
  }),
);

// ~$0.10/run: a Consumption environment (idle is free), two 0.25 vCPU apps
// (one always on) for ~20 min, two Basic registries, Service Bus Standard.
// ~25-36 min: the environment provisions first; the apps take ~5 min.
const runtime = beforeAll(deploy(RuntimeStack).pipe(withManagedEnvironment), {
  timeout: 3_000_000,
});
// Deleting a Workload Profiles environment takes up to ~25 minutes.
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(RuntimeStack), { timeout: 2_700_000 });

/** A unique payload id per run (payloads, not resource names). */
const runId = (prefix: string) => `${prefix}${Date.now().toString(36)}`;

// Sequential: the last case redeploys the shared stack.
describe.sequential("runtime", () => {
  test.provider(
    "async container app serves fetch with literal, Config, secret, and resource env",
    (_stack) =>
      Effect.gen(function* () {
        const out = (yield* runtime).async;
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
        expect(body.node).toMatch(/^24\./);

        // Out of band: system identity, the pushed image, the registry token,
        // and the secret behind the Redacted env value.
        const observed = yield* getApp(out.resourceGroup, out.name);
        expect(observed.identity?.type).toBe("SystemAssigned");
        const container = observed.properties?.template?.containers?.[0];
        expect(container?.name).toBe("main");
        expect(container?.image).toBe(out.image);
        expect(container?.env?.find((e) => e.name === "SECRET")?.secretRef).toBe("env-secret");
        const loginServer = out.image!.split("/")[0]!;
        expect(loginServer).toMatch(/\.azurecr\.io$/);
        expect(
          observed.properties?.configuration?.registries?.map((r) => [
            r.server,
            // The SDK marks the secret's name sensitive.
            Redacted.isRedacted(r.passwordSecretRef)
              ? Redacted.value(r.passwordSecretRef)
              : r.passwordSecretRef,
          ]),
        ).toEqual([[loginServer, "alchemy-registry"]]);
        const secrets = yield* listSecrets(out.resourceGroup, out.name);
        expect(
          JSON.parse(secrets.value.find((s) => s.name === "env-secret")?.value ?? "{}"),
        ).toEqual({ _tag: "Redacted", value: "s3cret" });

        // The image is the base plus one program layer, tagged with the code hash.
        const manifest = yield* acr.GetContainerRegistryManifest({
          endpoint: `https://${loginServer}`,
          name: out.name,
          reference: out.codeHash!,
        });
        expect(out.image).toBe(`${loginServer}/${out.name}:${out.codeHash}`);
        expect(manifest.layers?.at(-1)?.mediaType).toMatch(/tar\+gzip|tar\.gzip/);
        expect((manifest.layers ?? []).length).toBeGreaterThanOrEqual(2);
      }).pipe(logLevel),
    { timeout: 600_000 },
  );

  test.provider(
    "effect container app serves fetch and adds one KEDA rule per event source",
    (_stack) =>
      Effect.gen(function* () {
        const out = (yield* runtime).effect;
        expect(yield* fetchOk(`${out.url}/hello`)).toBe("hello from container apps");

        const observed = yield* getApp(out.resourceGroup, out.name);
        const scale = observed.properties?.template?.scale;
        expect(scale?.minReplicas).toBe(1);
        const rules = (scale?.rules ?? []).map((r) => ({
          name: r.name,
          queue: r.azureQueue?.queueName !== undefined,
          identity: r.azureQueue?.identity ?? r.custom?.identity,
          type: r.custom?.type,
        }));
        expect(rules.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))).toEqual([
          { name: "queue-appjobs", queue: true, identity: "system", type: undefined },
          { name: "sbq-apporders", queue: false, identity: "system", type: "azure-servicebus" },
          { name: "sbs-appaudit", queue: false, identity: "system", type: "azure-servicebus" },
        ]);
      }).pipe(logLevel),
    { timeout: 600_000 },
  );

  test.provider(
    "Storage.QueueEventSource runs the handler for an enqueued message",
    (_stack) =>
      Effect.gen(function* () {
        const out = (yield* runtime).effect;
        const id = runId("q");
        yield* fetchOk(`${out.url}/queue/send?id=${id}`);
        const recorded = JSON.parse(yield* pollOk(`${out.url}/result?key=queue/${id}`));
        expect(recorded.dequeueCount).toBe(1);
      }).pipe(logLevel),
    { timeout: 600_000 },
  );

  test.provider(
    "ServiceBus.QueueEventSource runs the handler for a sent message",
    (_stack) =>
      Effect.gen(function* () {
        const out = (yield* runtime).effect;
        const id = runId("s");
        yield* fetchOk(`${out.url}/servicebus/queue?id=${id}`);
        const recorded = JSON.parse(yield* pollOk(`${out.url}/result?key=servicebus-queue/${id}`));
        expect(recorded.deliveryCount).toBe(1);
      }).pipe(logLevel),
    { timeout: 600_000 },
  );

  test.provider(
    "ServiceBus.SubscriptionEventSource runs the handler for a published message",
    (_stack) =>
      Effect.gen(function* () {
        const out = (yield* runtime).effect;
        const id = runId("t");
        yield* fetchOk(`${out.url}/servicebus/topic?id=${id}`);
        const recorded = JSON.parse(yield* pollOk(`${out.url}/result?key=servicebus-topic/${id}`));
        expect(recorded.messageId).toMatch(/.+/);
      }).pipe(logLevel),
    { timeout: 600_000 },
  );

  test.provider(
    "ContainerApps.appSchedule runs the handler on its schedule",
    (_stack) =>
      Effect.gen(function* () {
        const out = (yield* runtime).effect;
        const since = Date.now() - 60_000;
        // The schedule fires every minute; wait for a run after this test began.
        const recorded = yield* pollOk(`${out.url}/result?key=schedule/last`).pipe(
          Effect.map((body) => JSON.parse(body) as { at: string; scheduledTime: string }),
          Effect.repeat({
            schedule: Schedule.spaced("15 seconds"),
            until: (run) => Date.parse(run.at) >= since,
            times: 12,
          }),
        );
        expect(Date.parse(recorded.at)).toBeGreaterThanOrEqual(since);
        expect(new Date(recorded.scheduledTime).getUTCSeconds()).toBe(0);
      }).pipe(logLevel),
    { timeout: 600_000 },
  );

  test.provider(
    "redeploying the effect container app keeps its role assignments",
    (_stack) =>
      Effect.gen(function* () {
        const out = yield* runtime;
        expect(out.effect.principalId).toMatch(/^[0-9a-f-]{36}$/);
        const before = yield* roleAssignmentsOf(out.effect.principalId!);
        // The event sources' own grants are among them.
        expect(before).toContain(
          `${out.ordersQueueId.toLowerCase()}|090c5cfd-751d-490a-894a-3ce6f1109419`,
        );
        expect(before).toContain(
          `${out.auditId.toLowerCase()}|090c5cfd-751d-490a-894a-3ce6f1109419`,
        );
        expect(before).toContain(
          `${out.jobsQueueId.toLowerCase()}|${Azure.Authorization.BuiltInRole.StorageQueueDataReader}`,
        );

        // A changed env value rolls a new revision in place; the image stays.
        const config = yield* ConfigProvider.ConfigProvider;
        const redeployed = yield* deploy(RuntimeStack).pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.orElse(
              ConfigProvider.fromEnv({ env: { AZURE_CA_EFFECT_GREETING: "hi" } }),
              config,
            ),
          ),
        );
        expect(redeployed.effect.name).toBe(out.effect.name);
        expect(redeployed.effect.image).toBe(out.effect.image);
        expect(
          yield* pollOk(`${out.effect.url}/hello`).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("10 seconds"),
              until: (body) => body === "hi from container apps",
              times: 12,
            }),
          ),
        ).toBe("hi from container apps");

        expect(yield* roleAssignmentsOf(out.effect.principalId!)).toEqual(before);
        // …and the bindings still work with them.
        const id = runId("r");
        yield* fetchOk(`${out.effect.url}/blob/write?key=redeploy/${id}&value=still-here`);
        expect(yield* fetchOk(`${out.effect.url}/result?key=redeploy/${id}`)).toBe("still-here");
      }).pipe(logLevel),
    { timeout: 900_000 },
  );
});
