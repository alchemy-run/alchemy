import * as Azure from "@alchemy.run/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as web from "@distilled.cloud/azure/web";
import * as Alchemy from "alchemy";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { AsyncWebApp, AsyncWebAppContainer } from "./fixtures/async-webapp-stack.ts";
import EffectWebApp, { WebAppFiles } from "./fixtures/effect-webapp.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const where = (resourceGroupName: string, name: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return { subscriptionId, resourceGroupName, name };
  });

const getApp = (resourceGroupName: string, name: string) =>
  where(resourceGroupName, name).pipe(Effect.flatMap(web.GetWebApp));

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

const program = (props: {
  os: "linux" | "windows";
  siteConfig: Azure.Web.SiteConfig;
  appSettings: Record<string, string>;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    // The free trial has F1 quota in westus3 (centralus plan creates are throttled). Both plans
    // stay deployed so the OS replacement never removes a live dependency.
    const linuxPlan = yield* Azure.Web.AppServicePlan("LinuxPlan", {
      resourceGroup: group.resourceGroupName,
      location: "westus3",
      sku: "F1",
      os: "linux",
    });
    const windowsPlan = yield* Azure.Web.AppServicePlan("WindowsPlan", {
      resourceGroup: group.resourceGroupName,
      location: "westus3",
      sku: "F1",
      os: "windows",
    });
    const app = yield* Azure.Web.WebApp("Site", {
      resourceGroup: group.resourceGroupName,
      serverFarmId:
        props.os === "linux" ? linuxPlan.appServicePlanId : windowsPlan.appServicePlanId,
      os: props.os,
      siteConfig: props.siteConfig,
      appSettings: props.appSettings,
      tags: props.tags,
    });
    return { group, app };
  });

// Cost: $0 (F1 Free plans). Provisioning: ~1-2 minutes.
test.provider(
  "create, update, replace, and delete a web app",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, app } = yield* stack.deploy(
        program({
          os: "linux",
          siteConfig: { linuxFxVersion: "NODE|20-lts", alwaysOn: false },
          appSettings: { GREETING: "hello" },
          tags: { env: "test" },
        }),
      );
      expect(app.kind).toEqual("app,linux");
      expect(app.os).toEqual("linux");
      expect(app.defaultHostName).toEqual(`${app.siteName}.azurewebsites.net`);
      expect(app.state).toEqual("Running");

      const observed = yield* getApp(group.resourceGroupName, app.siteName);
      expect(observed.properties?.httpsOnly).toEqual(true);
      expect(observed.properties?.reserved).toEqual(true);
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Site");
      const config = yield* where(group.resourceGroupName, app.siteName).pipe(
        Effect.flatMap(web.GetWebAppConfiguration),
      );
      expect(config.properties?.linuxFxVersion).toEqual("NODE|20-lts");
      const settings = yield* where(group.resourceGroupName, app.siteName).pipe(
        Effect.flatMap(web.ListWebAppApplicationSettings),
      );
      expect(settings.properties?.GREETING).toEqual("hello");

      // The default host serves the platform's placeholder page.
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get(app.url).pipe(
        Effect.flatMap((res) =>
          res.status === 200 ? Effect.succeed(res) : Effect.fail(res.status),
        ),
        Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
      );
      expect(response.status).toEqual(200);

      // In-place update: site config, app settings, and tags.
      const updated = yield* stack.deploy(
        program({
          os: "linux",
          siteConfig: {
            linuxFxVersion: "NODE|22-lts",
            alwaysOn: false,
            http20Enabled: true,
          },
          appSettings: { GREETING: "bonjour", MODE: "prod" },
          tags: { env: "prod" },
        }),
      );
      expect(updated.app.siteName).toEqual(app.siteName);
      const reconfig = yield* where(group.resourceGroupName, app.siteName).pipe(
        Effect.flatMap(web.GetWebAppConfiguration),
      );
      expect(reconfig.properties?.linuxFxVersion).toEqual("NODE|22-lts");
      expect(reconfig.properties?.http20Enabled).toEqual(true);
      const resettings = yield* where(group.resourceGroupName, app.siteName).pipe(
        Effect.flatMap(web.ListWebAppApplicationSettings),
      );
      expect(resettings.properties).toEqual({
        GREETING: "bonjour",
        MODE: "prod",
      });
      const retagged = yield* getApp(group.resourceGroupName, app.siteName);
      expect(retagged.tags?.env).toEqual("prod");

      // Replacement: Linux -> Windows cannot change in place.
      const replaced = yield* stack.deploy(
        program({
          os: "windows",
          siteConfig: { alwaysOn: false },
          appSettings: { GREETING: "bonjour", MODE: "prod" },
          tags: { env: "prod" },
        }),
      );
      expect(replaced.app.siteName).not.toEqual(app.siteName);
      expect(replaced.app.kind).toEqual("app");
      const windows = yield* getApp(group.resourceGroupName, replaced.app.siteName);
      expect(windows.properties?.reserved ?? false).toEqual(false);
      expect(yield* appGone(group.resourceGroupName, app.siteName)).toEqual("gone");

      yield* stack.destroy();
      expect(yield* appGone(group.resourceGroupName, replaced.app.siteName)).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 600_000,
  },
);

class NotReady extends Data.TaggedError("NotReady")<{ status: number; body: string }> {
  override get message() {
    return `HTTP ${this.status}: ${this.body}`;
  }
}

/**
 * Send `request` until it answers 200, through the Linux container's cold
 * start after a deploy and role propagation: 5 s apart, 4 minutes at most.
 */
const sendOk = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.execute(request).pipe(
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
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 48 }),
    );
  });

const fetchOk = (url: string) => sendOk(HttpClientRequest.get(url));

const planGone = (serverFarmId: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const [, , , , resourceGroupName, , , , name] = serverFarmId.split("/");
    return yield* web.GetAppServicePlan({ subscriptionId, resourceGroupName, name }).pipe(
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

/**
 * The principal's role assignments once the list shows any: role-assignment
 * reads trail writes by seconds and can answer empty from a lagging replica.
 */
const listedRoleAssignmentsOf = (principalId: string) =>
  roleAssignmentsOf(principalId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (assignments) => assignments.length > 0,
      times: 12,
    }),
  );

// Cost: $0 (F1 Free plan). Provisioning: ~3-5 minutes.
test.provider(
  "async web app serves fetch with literal, Config, secret, and resource env",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* AsyncWebApp;
          const container = yield* AsyncWebAppContainer;
          return {
            url: app.url,
            name: app.siteName,
            resourceGroup: app.resourceGroup,
            serverFarmId: app.serverFarmId,
            codeHash: app.codeHash,
            container: container.containerName,
          };
        }),
      );
      expect(out.codeHash).toMatch(/^[0-9a-f]{16}$/);

      // Out of band: a Linux Node.js 22 app with a system-assigned identity,
      // started with the bundle, on the F1 plan Alchemy created for it.
      const site = yield* getApp(out.resourceGroup, out.name);
      expect(site.kind).toEqual("app,linux");
      expect(site.identity?.type).toEqual("SystemAssigned");
      const config = yield* where(out.resourceGroup, out.name).pipe(
        Effect.flatMap(web.GetWebAppConfiguration),
      );
      expect(config.properties?.linuxFxVersion).toEqual("NODE|22-lts");
      expect(config.properties?.appCommandLine).toEqual("node index.mjs");
      const { subscriptionId } = yield* Azure.AzureEnvironment.current;
      const [, , , , planGroup, , , , planName] = out.serverFarmId.split("/");
      const plan = yield* web.GetAppServicePlan({
        subscriptionId,
        resourceGroupName: planGroup,
        name: planName,
      });
      expect(plan.sku?.name).toEqual("F1");

      const body = JSON.parse(yield* fetchOk(`${out.url}/greet?name=azure`)) as {
        message: string;
        secretLength: number;
        container: string;
        method: string;
        path: string;
        node: string;
      };
      expect(body.message).toEqual("hello azure");
      expect(body.secretLength).toEqual("s3cret".length);
      expect(body.container).toEqual(out.container);
      expect(body.method).toEqual("GET");
      expect(body.path).toEqual("/greet");
      expect(body.node).toMatch(/^22\./);

      const posted = JSON.parse(
        yield* sendOk(
          HttpClientRequest.post(`${out.url}/echo`).pipe(HttpClientRequest.bodyText("ping")),
        ),
      ) as { method: string; body: string };
      expect(posted.method).toEqual("POST");
      expect(posted.body).toEqual("ping");

      yield* stack.destroy();
      expect(yield* appGone(out.resourceGroup, out.name)).toEqual("gone");
      expect(yield* planGone(out.serverFarmId)).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 900_000,
  },
);

const EffectStack = Alchemy.Stack(
  "AzureWebAppEffect",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const app = yield* EffectWebApp;
    const files = yield* WebAppFiles;
    return {
      url: app.url,
      name: app.siteName,
      resourceGroup: app.resourceGroup,
      principalId: app.principalId,
      containerId: files.containerId,
    };
  }),
);

// ~$0.01/run (a B1 plan for ~10 min, a Standard_LRS account with a few blobs); ~5 min.
const effect = beforeAll(deploy(EffectStack), { timeout: 900_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(EffectStack), { timeout: 600_000 });

test.provider(
  "effect web app serves fetch, runs its blob binding as the app's identity, and keeps grants on redeploy",
  (_stack) =>
    Effect.gen(function* () {
      const out = yield* effect;
      expect(yield* fetchOk(`${out.url}/hello`)).toMatch(/^hello from app service on node 22\./);

      // Out of band: the binding granted one role, on the container only.
      expect(out.principalId).toMatch(/^[0-9a-f-]{36}$/);
      const grants = yield* listedRoleAssignmentsOf(out.principalId!);
      expect(grants).toHaveLength(1);
      expect(grants[0]!.split("|")[0]).toEqual(out.containerId.toLowerCase());

      // Role assignments take a minute or two to apply: sendOk retries the 500s.
      yield* fetchOk(`${out.url}/blob/write?key=hello.txt&value=from-webapp`);
      const read = JSON.parse(yield* fetchOk(`${out.url}/blob/read?key=hello.txt`)) as {
        result: { text: string | null };
      };
      expect(read.result.text).toEqual("from-webapp");

      // Redeploying with a changed env value updates the app in place and
      // keeps its role assignments. One test, so no other case sees the
      // greeting change.
      const config = yield* ConfigProvider.ConfigProvider;
      const redeployed = yield* deploy(EffectStack).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.orElse(
            ConfigProvider.fromEnv({ env: { AZURE_WEBAPP_EFFECT_GREETING: "hi" } }),
            config,
          ),
        ),
      );
      expect(redeployed.name).toEqual(out.name);
      expect(
        yield* fetchOk(`${out.url}/hello`).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("10 seconds"),
            until: (body) => body.startsWith("hi from app service"),
            times: 18,
          }),
        ),
      ).toMatch(/^hi from app service/);

      expect(yield* listedRoleAssignmentsOf(out.principalId!)).toEqual(grants);
      // …and the binding still works with them.
      yield* fetchOk(`${out.url}/blob/write?key=redeploy.txt&value=still-here`);
      const reread = JSON.parse(yield* fetchOk(`${out.url}/blob/read?key=redeploy.txt`)) as {
        result: { text: string | null };
      };
      expect(reread.result.text).toEqual("still-here");
    }).pipe(logLevel),
  { tags: ["provider:azure", "provider:azure:web", "live"], timeout: 900_000 },
);
