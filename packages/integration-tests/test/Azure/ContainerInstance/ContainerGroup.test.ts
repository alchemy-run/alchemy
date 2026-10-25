import * as Azure from "@alchemy.run/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as aci from "@distilled.cloud/azure/containerinstance";
import * as containerregistry from "@distilled.cloud/azure/containerregistry";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { AsyncAciContainer, AsyncContainer } from "./fixtures/async-stack.ts";
import EffectContainer from "./fixtures/effect-container.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const getGroup = (resourceGroupName: string, containerGroupName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* aci.GetContainerGroup({
      subscriptionId,
      resourceGroupName,
      containerGroupName,
    });
  });

const groupGone = (resourceGroupName: string, containerGroupName: string) =>
  getGroup(resourceGroupName, containerGroupName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 12,
    }),
  );

const registryGone = (resourceGroupName: string, registryName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* containerregistry
      .GetRegistry({ subscriptionId, resourceGroupName, registryName })
      .pipe(
        Effect.as("found" as const),
        Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
          Effect.succeed("gone" as const),
        ),
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (status) => status === "gone",
          times: 12,
        }),
      );
  });

class NotReady extends Data.TaggedError("NotReady")<{ status: number; body: string }> {}

/** `GET url` until it answers 200 `times` times (spaced), returning the body. */
const getOk = (url: string, schedule: Schedule.Schedule<unknown>, times: number) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(url).pipe(
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
      Effect.retry({ schedule, times }),
    );
  });

/** Through DNS propagation and container start: 1 + 2 + … + 128 s, about 4 minutes. */
const fetchOk = (url: string) => getOk(url, Schedule.exponential("1 second"), 8);

/** Through role propagation (5 min). */
const pollOk = (url: string) => getOk(url, Schedule.spaced("10 seconds"), 30);

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

const program = (props: {
  greeting: string;
  restartPolicy: "Always" | "OnFailure";
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const web = yield* Azure.ContainerInstance.ContainerGroup("Web", {
      resourceGroup: group.resourceGroupName,
      restartPolicy: props.restartPolicy,
      containers: [
        {
          name: "web",
          image: "mcr.microsoft.com/azuredocs/aci-helloworld",
          cpu: 0.5,
          memoryInGB: 0.5,
          ports: [{ port: 80 }],
          environment: { GREETING: props.greeting },
        },
      ],
      ipAddress: { type: "Public", ports: [{ port: 80, protocol: "TCP" }] },
      tags: props.tags,
    });
    return { group, web };
  });

// ~0.5 vCPU / 0.5 GB for a few minutes: well under $0.05 per run.
test.provider(
  "create, update, replace, and delete a container group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, web } = yield* stack.deploy(
        program({
          greeting: "hello",
          restartPolicy: "Always",
          tags: { env: "test" },
        }),
      );
      expect(web.containerGroupName).toMatch(/^[a-z][a-z0-9-]{0,62}$/);
      expect(web.ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      expect(web.url).toBe(`http://${web.ip}`);
      const observed = yield* getGroup(group.resourceGroupName, web.containerGroupName);
      expect(observed.properties.provisioningState).toEqual("Succeeded");
      expect(observed.properties.restartPolicy).toEqual("Always");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.properties.containers[0]?.properties.environmentVariables).toEqual([
        { name: "GREETING", value: "hello" },
      ]);

      // In place: env var re-deploys the group, tags PATCH it.
      const updated = yield* stack.deploy(
        program({
          greeting: "bonjour",
          restartPolicy: "Always",
          tags: { env: "prod" },
        }),
      );
      expect(updated.web.containerGroupId).toEqual(web.containerGroupId);
      const reobserved = yield* getGroup(group.resourceGroupName, web.containerGroupName);
      expect(reobserved.tags?.env).toEqual("prod");
      expect(reobserved.properties.containers[0]?.properties.environmentVariables).toEqual([
        { name: "GREETING", value: "bonjour" },
      ]);

      // A restart policy change replaces the group with a new physical name.
      const replaced = yield* stack.deploy(
        program({
          greeting: "bonjour",
          restartPolicy: "OnFailure",
          tags: { env: "prod" },
        }),
      );
      const afterReplace = yield* getGroup(
        group.resourceGroupName,
        replaced.web.containerGroupName,
      );
      expect(afterReplace.properties.restartPolicy).toEqual("OnFailure");
      expect(afterReplace.properties.provisioningState).toEqual("Succeeded");
      expect(replaced.web.containerGroupName).not.toEqual(web.containerGroupName);
      expect(yield* groupGone(group.resourceGroupName, web.containerGroupName)).toEqual("gone");

      yield* stack.destroy();
      expect(yield* groupGone(group.resourceGroupName, replaced.web.containerGroupName)).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:containerinstance", "live"],
    timeout: 900_000,
  },
);

// 0.5 vCPU / 1 GB for a few minutes + a Basic registry (billed per day,
// ~$0.17): ~$0.20/run; ~6 min.
test.provider(
  "async program serves fetch with literal, Config, secret, and resource env",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* AsyncContainer;
          const container = yield* AsyncAciContainer;
          return {
            url: group.url,
            name: group.containerGroupName,
            resourceGroup: group.resourceGroup,
            image: group.image,
            container: container.containerName,
          };
        }),
      );

      // Out of band: the program's image in the group's registry, run with a
      // system-assigned identity; the secret is a secure variable.
      const observed = yield* getGroup(out.resourceGroup, out.name);
      expect(observed.identity?.type).toBe("SystemAssigned");
      const app = observed.properties.containers.find((c) => c.name === "app");
      expect(app?.properties.image).toBe(out.image);
      expect(out.image).toMatch(/^[a-z0-9]+\.azurecr\.io\/app:[0-9a-f]{16}$/);
      const env = Object.fromEntries(
        (app?.properties.environmentVariables ?? []).map((v) => [v.name, v.value ?? "<secure>"]),
      );
      expect(env.GREETING).toBe("hello");
      expect(env.SECRET).toBe("<secure>");

      expect(out.url).toMatch(/^http:\/\/.+\.azurecontainer\.io:3000$/);
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

      const registryName = out.image!.split(".")[0]!;
      yield* stack.destroy();
      expect(yield* groupGone(out.resourceGroup, out.name)).toBe("gone");
      expect(yield* registryGone(out.resourceGroup, registryName)).toBe("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:containerinstance", "live"],
    timeout: 900_000,
  },
);

const EffectStack = Alchemy.Stack(
  "AzureAciEffect",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const group = yield* EffectContainer;
    return {
      url: group.url,
      name: group.containerGroupName,
      resourceGroup: group.resourceGroup,
      principalId: group.principalId,
      image: group.image,
    };
  }),
);

// 0.5 vCPU / 1 GB for ~15 min + a Basic registry (~$0.17/day) + Standard
// LRS storage: ~$0.25/run; ~6 min deploy.
const effect = beforeAll(deploy(EffectStack), { timeout: 900_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(EffectStack), { timeout: 600_000 });

// The redeploy changes `/hello`, so these run in order.
describe.sequential("effect program", () => {
  test.provider(
    "effect program serves fetch with a Config env value",
    (_stack) =>
      Effect.gen(function* () {
        const out = yield* effect;
        expect(out.url).toMatch(/^http:\/\/.+\.azurecontainer\.io:3000$/);
        expect(yield* fetchOk(`${out.url}/hello`)).toBe("hello from aci");
      }),
    { tags: ["provider:azure", "provider:azure:containerinstance", "live"], timeout: 600_000 },
  );

  test.provider(
    "Storage.BlobContainerReadWrite works with the group's managed identity",
    (_stack) =>
      Effect.gen(function* () {
        const out = yield* effect;
        const body = JSON.parse(yield* pollOk(`${out.url}/blob?key=hello.txt&value=from-aci`)) as {
          result: { text: string };
        };
        expect(body.result.text).toBe("from-aci");
      }),
    { tags: ["provider:azure", "provider:azure:containerinstance", "live"], timeout: 600_000 },
  );

  test.provider(
    "redeploying the effect program keeps its role assignments",
    (_stack) =>
      Effect.gen(function* () {
        const out = yield* effect;
        expect(out.principalId).toMatch(/^[0-9a-f-]{36}$/);
        const before = yield* roleAssignmentsOf(out.principalId!);
        // BlobContainerReadWrite: Storage Blob Data Contributor on the container.
        expect(before.length).toBe(1);
        expect(before[0]).toMatch(
          /\/blobservices\/default\/containers\/.+\|ba92f5b4-2d11-453d-a403-e96b0029c9fe$/,
        );

        // A changed env value re-deploys the group in place.
        const config = yield* ConfigProvider.ConfigProvider;
        const redeployed = yield* deploy(EffectStack).pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.orElse(
              ConfigProvider.fromEnv({ env: { AZURE_ACI_EFFECT_GREETING: "hi" } }),
              config,
            ),
          ),
        );
        expect(redeployed.name).toBe(out.name);
        expect(redeployed.principalId).toBe(out.principalId);
        expect(redeployed.image).toBe(out.image);
        expect(yield* fetchOk(`${redeployed.url}/hello`)).toBe("hi from aci");

        expect(yield* roleAssignmentsOf(out.principalId!)).toEqual(before);
        // …and the binding still works with them.
        const body = JSON.parse(
          yield* pollOk(`${redeployed.url}/blob?key=redeploy.txt&value=still-here`),
        ) as { result: { text: string } };
        expect(body.result.text).toBe("still-here");
      }),
    { tags: ["provider:azure", "provider:azure:containerinstance", "live"], timeout: 900_000 },
  );
});
