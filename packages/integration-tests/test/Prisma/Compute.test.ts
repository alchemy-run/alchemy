import { PrismaClient } from "@alchemy.run/prisma/Client";
import { Compute, ComputeProvider } from "@alchemy.run/prisma/Compute";
import { ComputeArtifact, ComputeArtifactProvider } from "@alchemy.run/prisma/ComputeArtifact";
import { ComputeService, ComputeServiceProvider } from "@alchemy.run/prisma/ComputeService";
import { ComputeVersion, ComputeVersionProvider } from "@alchemy.run/prisma/ComputeVersion";
import { CustomDomain, CustomDomainProvider } from "@alchemy.run/prisma/CustomDomain";
import {
  EnvironmentVariable,
  EnvironmentVariableProvider,
} from "@alchemy.run/prisma/EnvironmentVariable";
import { WebsiteArtifact, WebsiteArtifactProvider } from "@alchemy.run/prisma/Website/Artifact";
import { deployWebsite } from "@alchemy.run/prisma/Website/FrameworkSite";
import { describe, expect, it } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { adopt } from "alchemy/AdoptPolicy";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import * as Provider from "alchemy/Provider";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import { Resource } from "alchemy/Resource";
import { CurrentRuntimeContext } from "alchemy/RuntimeContext";
import { isActionState, State } from "alchemy/State/State";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { WebSocketServer } from "ws";
import { Credentials } from "../../../prisma/src/internal/Credentials.ts";
import ApiLive, { Api } from "./fixtures/class-form-compute.ts";
import { type ComputeCloud, makeComputeCloud } from "./fixtures/ComputeCloud.ts";
import { makeFakeManagementApi, unhandled } from "./fixtures/FakeManagementApi.ts";
import { testStackContext } from "./fixtures/StackContext.ts";

const tags = [
  "unit",
  "local",
  "provider:prisma",
  "provider:prisma:compute",
  "provider:prisma:computeartifact",
  "provider:prisma:computeservice",
  "provider:prisma:computeversion",
  "provider:prisma:environmentvariable",
];

const artifactV1 = `${import.meta.dirname}/fixtures/compute-v1.tar.gz`;
const artifactV2 = `${import.meta.dirname}/fixtures/compute-v2.tar.gz`;
const effectMain = `${import.meta.dirname}/fixtures/compute-effect-main.ts`;

/** Reads one attribute of another resource, as a downstream consumer would. */
interface Reader extends Resource<
  "Test.Prisma.ComputeReader",
  { value: unknown },
  { value: unknown }
> {}
const Reader = Resource<Reader>("Test.Prisma.ComputeReader");
const ReaderProvider = () =>
  Provider.succeed(Reader, {
    list: () => Effect.succeed([]),
    reconcile: Effect.fn(function* ({ news }) {
      return { value: news.value };
    }),
    delete: Effect.fn(function* () {}),
  });

class ComputeTestProviders extends Provider.ProviderCollection<ComputeTestProviders>()("Prisma") {}

/** One fake platform per test, so tests that run at the same time never share calls. */
const harness = () => {
  const cloud = makeComputeCloud();
  const providers = Layer.effect(
    ComputeTestProviders,
    Provider.collection([
      Compute,
      ComputeArtifact,
      ComputeService,
      ComputeVersion,
      CustomDomain,
      EnvironmentVariable,
      Reader,
      WebsiteArtifact,
    ]),
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        ComputeProvider(),
        ComputeArtifactProvider(),
        ComputeServiceProvider(),
        ComputeVersionProvider(),
        CustomDomainProvider(),
        EnvironmentVariableProvider(),
        ReaderProvider(),
        WebsiteArtifactProvider(),
      ),
    ),
    Layer.provideMerge(Layer.succeed(PrismaClient, cloud.domainClient)),
    Layer.provide(
      Layer.succeed(AlchemyContext, { dotAlchemy: ".alchemy-test", dev: false, adopt: false }),
    ),
    Layer.provideMerge(cloud.fake.layer),
  );
  return { cloud, test: Test.make({ providers, sidecar: false }).test };
};

const checks = { urlReadinessTimeoutSeconds: 0.2, timeoutSeconds: 2, pollIntervalMs: 1 } as const;

const base = { project: "project-1", branchId: "branch-1", ...checks } as const;

const rows = (stack: Test.ScratchStack) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const fqns = yield* state.list({ stack: stack.name, stage: stack.stage });
    const result: Record<string, { resourceType: string; attr: any; props: any }> = {};
    for (const fqn of fqns) {
      const row = yield* state.get({ stack: stack.name, stage: stack.stage, fqn });
      if (row && !isActionState(row)) {
        result[fqn] = { resourceType: row.resourceType, attr: row.attr, props: row.props };
      }
    }
    return result;
  }).pipe(Effect.provide(stack.state));

const clearCalls = (cloud: ComputeCloud) =>
  Effect.sync(() => {
    cloud.fake.captured.length = 0;
  });

const uploads = (cloud: ComputeCloud) =>
  cloud.fake.captured.filter((request) => new URL(request.url).host === "upload.prisma.test")
    .length;

const graph = harness();
graph.test.provider(
  "declares the service, one variable per key and the version, writes the variables first, and reports them on the host",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = graph;
      yield* stack.destroy();

      const app = yield* stack.deploy(
        Compute("api", {
          ...base,
          artifactPath: artifactV1,
          env: { B_KEY: "two", A_KEY: Redacted.make("one"), DROPPED: null },
        }),
      );

      const state = yield* rows(stack);
      expect(Object.keys(state).sort()).toEqual([
        "api",
        "api/Env/A_KEY",
        "api/Env/B_KEY",
        "api/Service",
        "api/Version",
      ]);
      expect(cloud.writes()).toEqual([
        "POST /v1/services",
        "POST /v1/environment-variables",
        "POST /v1/environment-variables",
        "POST /v1/services/svc-1/deployments",
        "POST /v1/deployments/dep-1/start",
        "POST /v1/services/svc-1/promote",
      ]);
      expect(cloud.versionEnvironment.get("dep-1")).toEqual({ A_KEY: "one", B_KEY: "two" });
      expect(app).toMatchObject({
        serviceId: "svc-1",
        projectId: "project-1",
        regionId: "us-east-1",
        serviceEndpointDomain: "svc-1.stable.prisma.test",
        activeVersionId: "dep-1",
        versionId: "dep-1",
        versionEndpointDomain: "dep-1.preview.prisma.test",
        versionUrl: "https://dep-1.preview.prisma.test",
        url: "https://svc-1.stable.prisma.test",
        environmentKeys: ["A_KEY", "B_KEY"],
        local: false,
        composed: true,
      });
      // The version records digests of the values, never the values.
      expect(JSON.stringify(state["api/Version"]?.props)).not.toContain("one");
      expect(Object.keys(state["api/Version"]?.props.triggers.environment)).toEqual([
        "A_KEY",
        "B_KEY",
      ]);

      yield* clearCalls(cloud);
      const again = yield* stack.deploy(
        Compute("api", {
          ...base,
          artifactPath: artifactV1,
          env: { B_KEY: "two", A_KEY: Redacted.make("one"), DROPPED: null },
        }),
      );
      expect(again.versionId).toBe("dep-1");
      expect(cloud.deployments.size).toBe(1);

      yield* stack.destroy();
      expect(cloud.services.size).toBe(0);
      expect(cloud.variables.size).toBe(0);
    }),
  { tags },
);

const build = harness();
build.test.provider(
  "declares the artifact when Compute builds, and not with artifactPath",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* stack.destroy();
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-prisma-compute-" });
      yield* fs.writeFileString(path.join(root, "server.js"), "console.log('one');\n");

      const app = yield* stack.deploy(
        Compute("api", { ...base, path: root, entrypoint: "server.js", port: 3000 }),
      );
      const state = yield* rows(stack);
      expect(Object.keys(state).sort()).toEqual([
        "api",
        "api/Artifact",
        "api/Service",
        "api/Version",
      ]);
      expect(state["api/Version"]?.props.portMapping).toEqual({ http: 3000 });
      expect(app.versionId).toBe("dep-1");
      expect(uploads(build.cloud)).toBe(1);

      yield* fs.writeFileString(path.join(root, "server.js"), "console.log('two');\n");
      const changed = yield* stack.deploy(
        Compute("api", { ...base, path: root, entrypoint: "server.js", port: 3000 }),
      );
      expect(changed.versionId).toBe("dep-2");
      expect(changed.activeVersionId).toBe("dep-2");
      // The replaced version is kept on the platform for its rollback.
      expect(build.cloud.deployments.has("dep-1")).toBe(true);

      yield* stack.destroy();
    }).pipe(Effect.scoped),
  { tags },
);

const values = harness();
values.test.provider(
  "creates a new version when a value changes or a key is removed, and keeps it otherwise",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = values;
      yield* stack.destroy();
      const app = (env: Record<string, string>) =>
        Compute("api", { ...base, artifactPath: artifactV1, env });

      const first = yield* stack.deploy(app({ LOG_LEVEL: "info", FLAG: "on" }));
      const unchanged = yield* stack.deploy(app({ LOG_LEVEL: "info", FLAG: "on" }));
      expect(unchanged.versionId).toBe(first.versionId);

      const changed = yield* stack.deploy(app({ LOG_LEVEL: "debug", FLAG: "on" }));
      expect(changed.versionId).not.toBe(first.versionId);
      expect(cloud.versionEnvironment.get(changed.versionId!)).toEqual({
        LOG_LEVEL: "debug",
        FLAG: "on",
      });

      const removed = yield* stack.deploy(app({ LOG_LEVEL: "debug" }));
      expect(removed.versionId).not.toBe(changed.versionId);
      expect(removed.environmentKeys).toEqual(["LOG_LEVEL"]);
      expect(cloud.environment()).toEqual({ LOG_LEVEL: "debug" });
      expect(Object.keys(yield* rows(stack))).not.toContain("api/Env/FLAG");

      yield* stack.destroy();
    }),
  { tags },
);

const classForm = harness();
classForm.test.provider(
  "declares the variables a class-form init sets, with a binding overriding env, and an init that returns nothing",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = classForm;
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* Compute(
            "api",
            { ...base, main: effectMain, env: { FROM_PROPS: "p", SHARED: "from-props" } },
            Effect.gen(function* () {
              const context = yield* CurrentRuntimeContext;
              yield* context!.set("FROM_BIND", Output.literal("bound"));
              yield* context!.set("SHARED", Output.literal("from-binding"));
              return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
            }),
          );
          const quiet = yield* Compute(
            "quiet",
            { ...base, main: effectMain },
            Effect.gen(function* () {
              const context = yield* CurrentRuntimeContext;
              yield* context!.set("QUIET", Output.literal("q"));
            }),
          );
          return { api, quiet };
        }),
      );

      const state = yield* rows(stack);
      expect(Object.keys(state).sort()).toEqual([
        "api",
        "api/Artifact",
        "api/Env/FROM_BIND",
        "api/Env/FROM_PROPS",
        "api/Env/SHARED",
        "api/Service",
        "api/Version",
        "quiet",
        "quiet/Artifact",
        "quiet/Env/QUIET",
        "quiet/Service",
        "quiet/Version",
      ]);
      // Binding values keep their JSON encoding, which the bundle decodes.
      expect(cloud.versionEnvironment.get(out.api.versionId!)).toMatchObject({
        FROM_PROPS: "p",
        FROM_BIND: '"bound"',
        SHARED: '"from-binding"',
      });
      expect(out.api.environmentKeys).toEqual(["FROM_BIND", "FROM_PROPS", "SHARED"]);
      expect(out.quiet.activeVersionId).toBe(out.quiet.versionId);

      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

const twice = harness();
twice.test.provider(
  "declares the children once when the same Compute is declared twice",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = twice;
      yield* stack.destroy();
      const app = Compute("api", { ...base, artifactPath: artifactV1, env: { A: "1" } });

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const first = yield* app;
          const second = yield* app;
          return { first, second };
        }),
      );
      expect(out.first.versionId).toBe(out.second.versionId);
      expect(cloud.services.size).toBe(1);
      expect(cloud.deployments.size).toBe(1);
      expect(cloud.variables.size).toBe(1);

      yield* stack.destroy();
    }),
  { tags },
);

const runtime = harness();
runtime.test.provider(
  "declares no children inside a deployed bundle",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const previous = globalThis.__ALCHEMY_RUNTIME__;
      globalThis.__ALCHEMY_RUNTIME__ = true;
      const plan = yield* stack
        .plan(Compute("api", { ...base, artifactPath: artifactV1, env: { A: "1" } }))
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              globalThis.__ALCHEMY_RUNTIME__ = previous;
            }),
          ),
        );
      expect(Object.keys(plan.resources)).toEqual(["api"]);
    }),
  { tags, exclusive: true },
);

const shared = harness();
shared.test.provider(
  "uses a service passed in, so a service's own URL and another's can be in the environment",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = shared;
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const webService = yield* ComputeService("web-service", base);
          const apiService = yield* ComputeService("api-service", base);
          const web = yield* Compute("web", {
            service: webService,
            artifactPath: artifactV1,
            ...checks,
            env: { PUBLIC_URL: webService.url, API_URL: apiService.url },
          });
          const api = yield* Compute("api", {
            service: apiService,
            artifactPath: artifactV2,
            ...checks,
            env: { WEB_URL: webService.url },
          });
          return { web, api, webService, apiService };
        }),
      );

      const state = yield* rows(stack);
      expect(Object.keys(state)).not.toContain("web/Service");
      expect(out.web.serviceId).toBe(out.webService.serviceId);
      expect(out.web.activeVersionId).toBe(out.web.versionId);
      expect(cloud.versionEnvironment.get(out.web.versionId!)).toMatchObject({
        PUBLIC_URL: out.webService.url,
        API_URL: out.apiService.url,
      });
      expect(cloud.versionEnvironment.get(out.api.versionId!)).toMatchObject({
        WEB_URL: out.webService.url,
      });

      yield* stack.destroy();
    }),
  { tags },
);

const skipPromote = harness();
skipPromote.test.provider(
  "with skipPromote attaches no active version and reports the preview URL",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = skipPromote;
      yield* stack.destroy();
      const app = (artifactPath: string) =>
        Compute("api", { ...base, artifactPath, skipPromote: true });

      const first = yield* stack.deploy(app(artifactV1));
      expect(first.url).toBe("https://dep-1.preview.prisma.test");
      expect(first.activeVersionId).toBeNull();
      expect(cloud.writes()).not.toContain("POST /v1/services/svc-1/promote");

      const second = yield* stack.deploy(app(artifactV2));
      expect(second.versionId).toBe("dep-2");
      expect(cloud.deployments.has("dep-1")).toBe(true);

      yield* stack.destroy();
    }),
  { tags },
);

const destroyOld = harness();
destroyOld.test.provider(
  "with destroyOldDeployment deletes the replaced version",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = destroyOld;
      yield* stack.destroy();
      const app = (artifactPath: string) =>
        Compute("api", { ...base, artifactPath, destroyOldDeployment: true });

      yield* stack.deploy(app(artifactV1));
      yield* clearCalls(cloud);
      const second = yield* stack.deploy(app(artifactV2));
      expect(second.versionId).toBe("dep-2");
      expect(cloud.writes()).toContain("DELETE /v1/deployments/dep-1");
      expect(cloud.deployments.has("dep-1")).toBe(false);

      yield* stack.destroy();
    }),
  { tags },
);

for (const kept of [true, false]) {
  const destroyActive = harness();
  destroyActive.test.provider(
    `never deletes the version the service serves on destroy with destroyOldDeployment (${kept ? "retain" : "default"} policy)`,
    (stack) =>
      Effect.gen(function* () {
        const { cloud } = destroyActive;
        yield* stack.destroy();
        const app = Compute("api", {
          ...base,
          artifactPath: artifactV1,
          destroyOldDeployment: true,
        });
        const deployed = yield* stack.deploy(kept ? app.pipe(RemovalPolicy.retain()) : app);
        yield* clearCalls(cloud);

        yield* stack.destroy();
        expect(cloud.writes()).not.toContain(`DELETE /v1/deployments/${deployed.versionId}`);
        if (kept) {
          // Everything kept, and the service still serves its version.
          expect(cloud.services.get(deployed.serviceId)?.latestDeploymentId).toBe(
            deployed.versionId,
          );
          expect(cloud.deployments.has(deployed.versionId!)).toBe(true);
        } else {
          expect(cloud.writes()).toContain(`DELETE /v1/services/${deployed.serviceId}`);
          expect(cloud.deployments.size).toBe(0);
        }
      }),
    { tags },
  );
}

const stackRetain = harness();
stackRetain.test.provider(
  "under a stack-wide retain policy, destroyOldDeployment deletes the replaced version and destroy keeps the served one",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = stackRetain;
      yield* stack.destroy();
      const program = (artifactPath: string) =>
        Effect.gen(function* () {
          return yield* Compute("api", { ...base, artifactPath, destroyOldDeployment: true });
        }).pipe(RemovalPolicy.retain());

      yield* stack.deploy(program(artifactV1));
      const second = yield* stack.deploy(program(artifactV2));
      expect(second.versionId).toBe("dep-2");
      expect(cloud.deployments.has("dep-1")).toBe(false);

      yield* stack.destroy();
      expect(cloud.services.get(second.serviceId)?.latestDeploymentId).toBe("dep-2");
      expect(cloud.deployments.has("dep-2")).toBe(true);
    }),
  { tags },
);

const stackPolicy = harness();
stackPolicy.test.provider(
  "keeps replaced versions under a stack-wide destroy policy, and replaces them under protect",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = stackPolicy;
      yield* stack.destroy();
      const app = (artifactPath: string) => Compute("api", { ...base, artifactPath });

      yield* stack.deploy(app(artifactV1).pipe(RemovalPolicy.destroy()));
      expect((yield* rows(stack))["api/Version"]).toBeDefined();
      const second = yield* stack.deploy(app(artifactV2).pipe(RemovalPolicy.destroy()));
      expect(second.versionId).toBe("dep-2");
      expect(cloud.deployments.has("dep-1")).toBe(true);

      const third = yield* stack.deploy(app(artifactV1).pipe(RemovalPolicy.protect()));
      expect(third.versionId).toBe("dep-3");
      expect(cloud.deployments.has("dep-2")).toBe(true);

      // Protection covers the service and variables, so lift it to destroy.
      yield* stack.deploy(app(artifactV1));
      yield* stack.destroy();
    }),
  { tags },
);

const reader = harness();
reader.test.provider(
  "gives a downstream resource the host's attributes, and the new version after a change",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const app = (artifactPath: string) =>
        Effect.gen(function* () {
          const api = yield* Compute("api", { ...base, artifactPath });
          const version = yield* Reader("Version", { value: api.versionId });
          const service = yield* Reader("Service", { value: api.serviceId });
          return { version, service };
        });

      const first = yield* stack.deploy(app(artifactV1));
      expect(first).toEqual({ version: { value: "dep-1" }, service: { value: "svc-1" } });
      const second = yield* stack.deploy(app(artifactV2));
      expect(second).toEqual({ version: { value: "dep-2" }, service: { value: "svc-1" } });

      yield* stack.destroy();
    }),
  { tags },
);

const invalid = harness();
invalid.test.provider(
  "rejects props that cannot be combined before anything is created",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = invalid;
      yield* stack.destroy();
      const failure = (props: Parameters<typeof Compute>[1]) =>
        stack.deploy(Compute("api", props)).pipe(Effect.flip, Effect.map(String));

      expect(
        yield* failure({
          ...base,
          artifactPath: artifactV1,
          skipPromote: true,
          destroyOldDeployment: true,
        }),
      ).toContain("destroyOldDeployment cannot be combined with skipPromote");
      expect(yield* failure({ ...base, artifactPath: artifactV1, start: false })).toContain(
        "start: false requires skipPromote: true",
      );
      expect(
        yield* failure({ service: "svc-x", project: "project-1", artifactPath: artifactV1 }),
      ).toContain("cannot also set project");
      expect(yield* failure({ service: "svc-x", artifactPath: artifactV1 })).toContain(
        "requires skipPromote: true",
      );
      expect(yield* failure({ artifactPath: artifactV1 })).toContain(
        "requires project, or service",
      );
      expect(
        yield* failure({ ...base, artifactPath: artifactV1, env: { "bad-key": "x" } }),
      ).toContain("POSIX env-var key shape");
      expect(cloud.fake.captured).toEqual([]);
    }),
  { tags },
);

const branchChange = harness();
branchChange.test.provider(
  "creates a new version when the service moves to another Branch",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const first = yield* stack.deploy(Compute("api", { ...base, artifactPath: artifactV1 }));
      const moved = yield* stack.deploy(
        Compute("api", { ...base, branchId: "branch-2", artifactPath: artifactV1 }),
      );
      expect(moved.serviceId).toBe(first.serviceId);
      expect(moved.versionId).not.toBe(first.versionId);
      expect(branchChange.cloud.services.get(first.serviceId)?.branchId).toBe("branch-2");

      yield* stack.destroy();
    }),
  { tags },
);

const identity = harness();
identity.test.provider(
  "gives the service the Compute's own logical ID, with '.' for '/'",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = identity;
      yield* stack.destroy();
      yield* stack.deploy(
        Effect.gen(function* () {
          yield* Compute("api", { ...base, artifactPath: artifactV1 });
          yield* Compute("api", { ...base, artifactPath: artifactV2 }).pipe(Namespace.push("Site"));
          yield* ComputeService("Web", base).pipe(Namespace.push("Site"));
        }),
      );
      expect([...cloud.services.values()].map((service) => service.logicalId).sort()).toEqual([
        "Site.Web",
        "Site.api",
        "api",
      ]);

      yield* stack.destroy();
    }),
  { tags },
);

const sharedLogicalId = harness();
sharedLogicalId.test.provider(
  "refuses two services whose addresses give one logical ID, before any write",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = sharedLogicalId;
      yield* stack.destroy();
      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            yield* ComputeService("b", base).pipe(Namespace.push("a"));
            yield* ComputeService("a.b", base);
          }),
        )
        .pipe(Effect.flip, Effect.map(String));
      expect(error).toContain("PrismaComputeServiceLogicalIdTaken");
      expect(error).toContain("'a.b'");
      expect(cloud.writes()).toEqual([]);
    }),
  { tags },
);

const unset = harness();
unset.test.provider(
  "declares no variable for a value that resolves to undefined, and deletes the one it wrote before",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = unset;
      yield* stack.destroy();
      const app = (value: string | undefined) =>
        Effect.gen(function* () {
          const source = yield* Reader("Source", { value });
          return yield* Compute("api", {
            ...base,
            artifactPath: artifactV1,
            env: {
              MAYBE: Output.map(source.value, (resolved) =>
                typeof resolved === "string" ? resolved : undefined,
              ),
            },
          });
        });

      const first = yield* stack.deploy(app("set"));
      expect(cloud.environment()).toEqual({ MAYBE: "set" });

      const cleared = yield* stack.deploy(app(undefined));
      expect(cloud.environment()).toEqual({});
      expect(cleared.versionId).not.toBe(first.versionId);
      expect(cloud.versionEnvironment.get(cleared.versionId!)).toEqual({});

      const again = yield* stack.deploy(app("set"));
      expect(cloud.environment()).toEqual({ MAYBE: "set" });
      expect(again.versionId).not.toBe(cleared.versionId);

      yield* stack.destroy();
      expect(cloud.variables.size).toBe(0);
    }),
  { tags },
);

const wrongClass = harness();
wrongClass.test.provider(
  "fails with a typed error when envClass does not match the Branch, before the service is created, and while planning once it exists",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = wrongClass;
      yield* stack.destroy();
      const app = (envClass?: "preview") =>
        Compute("api", {
          ...base,
          artifactPath: artifactV1,
          env: { A: "1" },
          ...(envClass ? { envClass } : {}),
        });

      const create = yield* stack.deploy(app("preview")).pipe(Effect.flip);
      expect(create).toMatchObject({ _tag: "ComputeServiceInvalidProps" });
      expect(cloud.writes()).toEqual([]);

      yield* stack.deploy(app());
      yield* clearCalls(cloud);
      const plan = yield* stack.plan(app("preview")).pipe(Effect.flip);
      expect(plan).toMatchObject({ _tag: "ComputeServiceInvalidProps" });
      expect(String(plan.message)).toContain("does not match the role 'production'");
      expect(cloud.writes()).toEqual([]);

      yield* stack.destroy();
    }),
  { tags },
);

const noBranch = harness();
noBranch.test.provider(
  "fails with a typed error when the service given by ID has no Branch",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = noBranch;
      yield* stack.destroy();
      cloud.services.set("svc-detached", {
        id: "svc-detached",
        type: "service",
        url: "",
        name: "detached",
        region: { id: "us-east-1", name: "us-east-1" },
        projectId: "project-1",
        branchId: null,
        latestDeploymentId: null,
        appEndpointDomain: "svc-detached.stable.prisma.test",
        createdAt: "2026-01-01T00:00:00.000Z",
        logicalId: null,
      });
      const error = yield* stack
        .deploy(
          Compute("api", {
            service: "svc-detached",
            skipPromote: true,
            artifactPath: artifactV1,
            env: { A: "1" },
            ...checks,
          }),
        )
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "EnvironmentVariableInvalidProps" });
      expect(String(error.message)).toContain("attached to no Branch");
      expect(cloud.writes()).toEqual([]);

      yield* stack.destroy();
    }),
  { tags },
);

const sharedKey = harness();
sharedKey.test.provider(
  "says plainly when two Computes declare one key in one project and Branch",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            yield* Compute("web", { ...base, artifactPath: artifactV1, env: { API_KEY: "a" } });
            yield* Compute("api", { ...base, artifactPath: artifactV2, env: { API_KEY: "b" } });
          }),
        )
        .pipe(Effect.flip, Effect.map(String));
      expect(error).toContain("EnvironmentVariableConflict");
      expect(error).toContain("'API_KEY'");
      expect(error).toContain("not to one service");

      // A later deploy, which finds the variable already written, says the same.
      const again = yield* stack
        .deploy(
          Effect.gen(function* () {
            yield* Compute("web", { ...base, artifactPath: artifactV1, env: { API_KEY: "a" } });
            yield* Compute("api", { ...base, artifactPath: artifactV2, env: { API_KEY: "b" } });
          }),
        )
        .pipe(Effect.flip, Effect.map(String));
      expect(again).toContain("not to one service");
      expect(again).toMatch(/'(web|api)\/Env\/API_KEY' and also at '(web|api)\/Env\/API_KEY'/);

      yield* stack.destroy();
    }),
  { tags },
);

const otherScopes = harness();
otherScopes.test.provider(
  "does not count the same key in another project as shared, so an adopting deploy takes over its own variable",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = otherScopes;
      yield* stack.destroy();
      // Left on the platform in project-2 by lost state.
      cloud.variables.set("env-lost", {
        id: "env-lost",
        type: "environment_variable",
        url: "",
        projectId: "project-2",
        branchId: null,
        class: "production",
        key: "DATABASE_URL",
        valueKid: "kid-1",
        isManagedBySystem: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      const program = Effect.gen(function* () {
        yield* Compute("one", {
          ...base,
          artifactPath: artifactV1,
          env: { DATABASE_URL: "postgres://one" },
        });
        yield* Compute("two", {
          ...base,
          project: "project-2",
          artifactPath: artifactV2,
          env: { DATABASE_URL: "postgres://two" },
        });
      });

      yield* stack.deploy(program.pipe(adopt(true)));
      expect(cloud.values.get("env-lost")).toBe("postgres://two");
      expect(cloud.variables.size).toBe(2);

      yield* stack.destroy();
    }),
  { tags },
);

const readsUrl = harness();
readsUrl.test.provider(
  "creates no new version for either Compute when one reads the other's url and nothing changed",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = readsUrl;
      yield* stack.destroy();
      const program = Effect.gen(function* () {
        const web = yield* Compute("web", { ...base, artifactPath: artifactV1 });
        const api = yield* Compute("api", {
          ...base,
          artifactPath: artifactV2,
          env: { WEB_URL: web.url },
        });
        return { web, api };
      });

      const first = yield* stack.deploy(program);
      expect(cloud.versionEnvironment.get(first.api.versionId!)).toEqual({
        WEB_URL: first.web.url,
      });
      const second = yield* stack.deploy(program);
      expect(second.web.versionId).toBe(first.web.versionId);
      expect(second.api.versionId).toBe(first.api.versionId);
      expect(cloud.deployments.size).toBe(2);

      yield* stack.destroy();
    }),
  { tags },
);

const callerTriggers = harness();
callerTriggers.test.provider(
  "keeps a caller's triggers apart from the environment digests, whatever their keys",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const app = (value: string, release: string) =>
        Compute("api", {
          ...base,
          artifactPath: artifactV1,
          env: { A: value },
          triggers: { environment: release, branch: release },
        });

      const first = yield* stack.deploy(app("one", "r1"));
      const triggers = (yield* rows(stack))["api/Version"]?.props.triggers;
      expect(triggers.triggers).toEqual({ environment: "r1", branch: "r1" });
      expect(Object.keys(triggers.environment)).toEqual(["A"]);

      const value = yield* stack.deploy(app("two", "r1"));
      expect(value.versionId).not.toBe(first.versionId);
      const release = yield* stack.deploy(app("two", "r2"));
      expect(release.versionId).not.toBe(value.versionId);
      const unchanged = yield* stack.deploy(app("two", "r2"));
      expect(unchanged.versionId).toBe(release.versionId);

      yield* stack.destroy();
    }),
  { tags },
);

const forwarded = harness();
forwarded.test.provider(
  "forwards healthCheck to the version and the service, which restores the earlier version when the stable URL fails",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = forwarded;
      yield* stack.destroy();
      const app = (artifactPath: string) =>
        Compute("api", { ...base, artifactPath, healthCheck: { path: "/health" } });

      const first = yield* stack.deploy(app(artifactV1));
      const state = yield* rows(stack);
      expect(state["api/Service"]?.props.healthCheck).toEqual({ path: "/health" });
      expect(state["api/Version"]?.props.healthCheck).toEqual({ path: "/health" });

      cloud.knobs.failingActiveVersions.add("dep-2");
      const failure = yield* stack.deploy(app(artifactV2)).pipe(Effect.flip, Effect.map(String));
      expect(failure).toContain("ComputeServiceEndpointCheckFailed");
      expect(cloud.services.get(first.serviceId)?.latestDeploymentId).toBe(first.versionId);

      yield* stack.destroy();
    }),
  { tags },
);

const stuck = harness();
stuck.test.provider(
  "reports a failed version that will not stop, and destroy deletes nothing until it has stopped",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = stuck;
      yield* stack.destroy();
      const first = yield* stack.deploy(Compute("api", { ...base, artifactPath: artifactV1 }));
      expect(first.versionId).toBe("dep-1");

      cloud.knobs.failingPreviews.add("dep-2.preview.prisma.test");
      cloud.knobs.stuckStopping.add("dep-2");
      const failure = yield* stack
        .deploy(Compute("api", { ...base, artifactPath: artifactV2 }))
        .pipe(Effect.flip, Effect.map(String));
      expect(failure).toContain("ComputeVersionNotRemoved");
      expect(failure).toMatch(
        /Timed out after 0\.2 s.*Alchemy then stopped Prisma Compute version 'dep-2'.*still stopping it after 2 s/s,
      );
      expect(cloud.deployments.get("dep-2")?.status).toBe("stopping");
      expect(cloud.services.get(first.serviceId)?.latestDeploymentId).toBe("dep-1");

      const refused = yield* stack.destroy().pipe(Effect.flip, Effect.map(String));
      expect(refused).toContain("DeleteInProgress");
      expect(refused).toContain("'dep-2' is still stopping");
      expect(refused).toContain("still serves 'dep-1'");
      expect(cloud.services.get(first.serviceId)?.latestDeploymentId).toBe("dep-1");
      expect(cloud.deployments.has("dep-1")).toBe(true);

      cloud.knobs.stuckStopping.delete("dep-2");
      cloud.deployments.get("dep-2")!.status = "stopped";
      yield* stack.destroy();
      expect(cloud.services.size).toBe(0);
      expect(cloud.deployments.size).toBe(0);
    }),
  { tags },
);

const unchecked = harness();
unchecked.test.provider(
  "forwards verifyUrl: false, so neither the version nor the service checks its URL",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = unchecked;
      yield* stack.destroy();
      cloud.knobs.failingPreviews.add("dep-1.preview.prisma.test");
      cloud.knobs.failingActiveVersions.add("dep-1");
      const app = yield* stack.deploy(
        Compute("api", { ...base, artifactPath: artifactV1, verifyUrl: false }),
      );
      expect(app.activeVersionId).toBe("dep-1");
      expect(cloud.probes()).toEqual([]);

      yield* stack.destroy();
    }),
  { tags },
);

const reuse = harness();
reuse.test.provider(
  "with skipCodeUpload declares no artifact and creates a version from the served code",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = reuse;
      yield* stack.destroy();
      yield* stack.deploy(Compute("api", { ...base, artifactPath: artifactV1, env: { A: "1" } }));
      yield* clearCalls(cloud);

      const reused = yield* stack.deploy(
        Compute("api", { ...base, skipCodeUpload: true, env: { A: "2" } }),
      );
      expect(Object.keys(yield* rows(stack))).not.toContain("api/Artifact");
      expect(reused.versionId).toBe("dep-2");
      expect(uploads(cloud)).toBe(0);
      expect(
        cloud.fake.captured.find((request) => request.pathname.endsWith("/deployments"))?.bodyJson,
      ).toMatchObject({ skipCodeUpload: true });

      yield* stack.destroy();
    }),
  { tags },
);

const noManifest = harness();
noManifest.test.provider(
  "refuses a prebuilt archive without compute.manifest.json before creating a version",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = noManifest;
      yield* stack.destroy();
      const error = yield* stack
        .deploy(
          Compute("api", {
            ...base,
            artifactPath: `${import.meta.dirname}/fixtures/compute-no-manifest.tar.gz`,
          }),
        )
        .pipe(Effect.flip, Effect.map(String));
      expect(error).toContain("ComputeVersionInvalidProps");
      expect(error).toContain("has no compute.manifest.json at its root");
      expect(cloud.writes().filter((write) => write.includes("/deployments"))).toEqual([]);
      expect(cloud.deployments.size).toBe(0);

      yield* stack.destroy();
    }),
  { tags },
);

const classExample = harness();
classExample.test.provider(
  "deploys the class-form example from the JSDoc, with a decoration around Effect.provide",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const api = yield* stack.deploy(Api.pipe(Effect.provide(ApiLive), RemovalPolicy.retain()));
      expect(api.activeVersionId).toBe(api.versionId);
      const state = yield* rows(stack);
      expect(Object.keys(state).sort()).toEqual([
        "api",
        "api/Artifact",
        "api/Service",
        "api/Version",
      ]);

      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

const domain = harness();
domain.test.provider(
  "attaches a custom domain to the Compute's service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* Compute("api", { ...base, artifactPath: artifactV1 });
          const hostname = yield* CustomDomain("Domain", {
            service: api,
            hostname: "api.example.test",
          });
          return { api, hostname };
        }),
      );
      expect(out.hostname.serviceId).toBe(out.api.serviceId);
      expect([...domain.cloud.domains.values()].map((entry) => entry.appId)).toEqual(["svc-1"]);

      // A new version keeps the domain on the same service.
      const again = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* Compute("api", { ...base, artifactPath: artifactV2 });
          const hostname = yield* CustomDomain("Domain", {
            service: api,
            hostname: "api.example.test",
          });
          return { api, hostname };
        }),
      );
      expect(again.api.versionId).toBe("dep-2");
      expect(again.hostname.customDomainId).toBe(out.hostname.customDomainId);

      yield* stack.destroy();
      expect(domain.cloud.domains.size).toBe(0);
    }),
  { tags: [...tags, "provider:prisma:customdomain"] },
);

const website = harness();
website.test.provider(
  "deploys a Website's Compute from its artifact, with a custom domain on top",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* stack.destroy();
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-prisma-website-" });
      const dist = path.join(root, "dist");
      yield* fs.makeDirectory(dist);
      yield* fs.writeFileString(path.join(dist, "index.html"), "<h1>site</h1>");

      const site = yield* stack.deploy(
        Effect.gen(function* () {
          const artifact = yield* WebsiteArtifact("Artifact", { root, distDir: dist, static: {} });
          return yield* deployWebsite(
            {
              project: "project-1",
              branchId: "branch-1",
              domain: "www.example.test",
              compute: { ...checks },
            },
            artifact,
          );
        }),
      );
      const state = yield* rows(stack);
      expect(Object.keys(state).sort()).toEqual([
        "Artifact",
        "Compute",
        "Compute/Env/HOST",
        "Compute/Env/NODE_ENV",
        "Compute/Env/PORT",
        "Compute/Service",
        "Compute/Version",
        "Domain",
      ]);
      expect(site.compute?.url).toBe("https://svc-1.stable.prisma.test");
      expect(site.url).toBe("https://www.example.test");
      expect(website.cloud.versionEnvironment.get("dep-1")).toEqual({
        HOST: "0.0.0.0",
        NODE_ENV: "production",
        PORT: "3000",
      });

      yield* stack.destroy();
    }).pipe(Effect.scoped),
  { tags: [...tags, "provider:prisma:customdomain", "provider:prisma:website"] },
);

/** A state row as `Prisma.Compute` 2.0.0-beta.87 wrote it, under either attribute naming. */
const writeEarlierRow = (
  stack: Test.ScratchStack,
  cloud: ComputeCloud,
  naming: "before-rename" | "after-rename",
) =>
  Effect.gen(function* () {
    cloud.services.set("svc-old", {
      id: "svc-old",
      type: "service",
      url: "",
      name: "api-old",
      region: { id: "us-east-1", name: "us-east-1" },
      projectId: "project-1",
      branchId: "branch-1",
      latestDeploymentId: "dep-old",
      appEndpointDomain: "svc-old.stable.prisma.test",
      createdAt: "2026-01-01T00:00:00.000Z",
      logicalId: null,
    });
    cloud.deployments.set("dep-old", {
      id: "dep-old",
      type: "deployment",
      url: "",
      serviceId: "svc-old",
      foundryVersionId: "foundry-old",
      status: "running",
      previewDomain: "dep-old.preview.prisma.test",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    cloud.variables.set("env-old", {
      id: "env-old",
      type: "environment_variable",
      url: "",
      projectId: "project-1",
      branchId: null,
      class: "production",
      key: "LOG_LEVEL",
      valueKid: "kid-1",
      isManagedBySystem: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    cloud.values.set("env-old", "info");
    const identity =
      naming === "before-rename"
        ? {
            appId: "svc-old",
            deploymentId: "dep-old",
            appName: "api-old",
            appEndpointDomain: "svc-old.stable.prisma.test",
            deploymentEndpointDomain: "dep-old.preview.prisma.test",
            deploymentUrl: "https://dep-old.preview.prisma.test",
          }
        : {
            serviceId: "svc-old",
            versionId: "dep-old",
            serviceName: "api-old",
            serviceEndpointDomain: "svc-old.stable.prisma.test",
            versionEndpointDomain: "dep-old.preview.prisma.test",
            versionUrl: "https://dep-old.preview.prisma.test",
          };
    const state = yield* yield* State;
    yield* state.set({
      stack: stack.name,
      stage: stack.stage,
      fqn: "api",
      value: {
        status: "created",
        logicalId: "api",
        fqn: "api",
        namespace: undefined,
        instanceId: "00000000000000000000000000000001",
        providerVersion: 0,
        resourceType: "Prisma.Compute",
        props: { project: "project-1", branchId: "branch-1", artifactPath: artifactV1 },
        attr: {
          ...identity,
          projectId: "project-1",
          regionId: "us-east-1",
          url: "https://svc-old.stable.prisma.test",
          promoted: true,
          previousDeploymentId: null,
          previousDeploymentAction: null,
          environmentKeys: ["LOG_LEVEL"],
          environmentVariableIds: { LOG_LEVEL: "env-old" },
          environmentClass: "production",
          environmentBranchId: null,
          artifactHash: Redacted.make("hash-old"),
          local: false,
        },
        removalPolicy: "destroy",
        bindings: [],
        downstream: [],
      } as never,
    });
  }).pipe(Effect.provide(stack.state));

/** What `alchemy state delete <stack>/<stage>/api` does. */
const forgetEarlierRow = (stack: Test.ScratchStack) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    yield* state.delete({ stack: stack.name, stage: stack.stage, fqn: "api" });
  }).pipe(Effect.provide(stack.state));

const oldApp = () =>
  Compute("api", { ...base, artifactPath: artifactV2, env: { LOG_LEVEL: "debug" } });

for (const naming of ["before-rename", "after-rename"] as const) {
  const earlier = harness();
  earlier.test.provider(
    `refuses a stack deployed with the earlier Compute (${naming} names) before any write, on deploy, removal and destroy`,
    (stack) =>
      Effect.gen(function* () {
        const { cloud } = earlier;
        yield* stack.destroy();
        yield* writeEarlierRow(stack, cloud, naming);
        yield* clearCalls(cloud);

        const deploy = yield* stack.deploy(oldApp()).pipe(Effect.flip);
        expect(deploy).toMatchObject({ _tag: "ComputeCannotUpgradeInPlace" });
        expect(String(deploy.message)).toContain("alchemy state delete");
        expect(String(deploy.message)).toContain("nothing was changed");
        // An old service has no logical ID, so nothing else claims it.
        const everything = yield* stack.deploy(oldApp()).pipe(
          Effect.sandbox,
          Effect.flip,
          Effect.map((cause) => Cause.pretty(cause)),
        );
        expect(everything).toContain("ComputeCannotUpgradeInPlace");
        expect(everything).not.toContain("OwnedBySomeoneElse");
        expect(cloud.writes()).toEqual([]);

        // Removing it from the program would run the earlier delete, which
        // deleted the service.
        const removal = yield* stack.deploy(Effect.void).pipe(Effect.flip);
        expect(String(removal)).toContain("ComputeCannotUpgradeInPlace");
        expect(String(removal)).toContain("neither changed nor deleted");
        expect(String(removal)).not.toContain("nothing was changed");
        expect(cloud.writes()).toEqual([]);

        const destroy = yield* stack.destroy().pipe(Effect.flip);
        expect(String(destroy)).toContain("ComputeCannotUpgradeInPlace");
        expect(cloud.writes()).toEqual([]);
        expect(cloud.services.has("svc-old")).toBe(true);
        expect(cloud.variables.has("env-old")).toBe(true);

        yield* forgetEarlierRow(stack);
        yield* stack.destroy();
      }),
    { tags },
  );
}

const movedWithName = harness();
movedWithName.test.provider(
  "moves a stack whose earlier Compute set serviceName, once the new service gets another name",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = movedWithName;
      yield* stack.destroy();
      yield* writeEarlierRow(stack, cloud, "after-rename");
      yield* forgetEarlierRow(stack);
      const named = (serviceName: string) =>
        Compute("api", {
          ...base,
          serviceName,
          artifactPath: artifactV2,
          env: { LOG_LEVEL: "debug" },
        }).pipe(adopt(true));

      // The old service still holds its name on the Branch.
      const clash = yield* stack.deploy(named("api-old")).pipe(Effect.flip, Effect.map(String));
      expect(clash).toContain("ComputeServiceConflict");

      const app = yield* stack.deploy(named("api-new"));
      expect(app.serviceName).toBe("api-new");
      expect(cloud.services.get("svc-old")?.name).toBe("api-old");

      yield* stack.destroy();
    }),
  { tags },
);

const moved = harness();
moved.test.provider(
  "moves a stack deployed with the earlier Compute by the steps its error gives",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = moved;
      yield* stack.destroy();
      yield* writeEarlierRow(stack, cloud, "after-rename");

      const refused = yield* stack.deploy(oldApp()).pipe(Effect.flip);
      expect(String(refused.message)).toContain(
        `alchemy state delete ${stack.name}/${stack.stage}/api`,
      );

      // Step 1: `alchemy state delete <stack>/<stage>/api`.
      yield* forgetEarlierRow(stack);
      // Step 2: deploy with `--adopt`.
      yield* clearCalls(cloud);
      const app = yield* stack.deploy(oldApp().pipe(adopt(true)));

      expect(app.serviceId).not.toBe("svc-old");
      expect(app.url).not.toBe("https://svc-old.stable.prisma.test");
      // The old service is untouched and still serves its version.
      expect(cloud.services.get("svc-old")?.latestDeploymentId).toBe("dep-old");
      expect(cloud.deployments.has("dep-old")).toBe(true);
      // Its variable is taken over, not duplicated.
      expect(cloud.variables.size).toBe(1);
      expect(cloud.values.get("env-old")).toBe("debug");

      yield* stack.destroy();
      expect(cloud.services.has("svc-old")).toBe(true);
    }),
  { tags },
);

const hostOutput = (versionId: string | undefined): Compute["Attributes"] => ({
  serviceId: "service-1",
  serviceName: "api",
  projectId: "project-1",
  regionId: "us-east-1",
  serviceEndpointDomain: "api.prisma.build",
  activeVersionId: versionId ?? null,
  versionId,
  versionEndpointDomain: versionId && `${versionId}.preview.prisma.build`,
  versionUrl: versionId && `https://${versionId}.preview.prisma.build`,
  url: "https://api.prisma.build",
  environmentKeys: [],
  local: false,
  composed: true,
});

const hostProvider = Provider.findProvider(Compute).pipe(
  Effect.provide(
    ComputeProvider().pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(AlchemyContext, { dotAlchemy: ".alchemy-test", dev: false, adopt: false }),
          testStackContext,
          PlatformServices,
        ),
      ),
    ),
  ),
  Effect.provide(makeFakeManagementApi(unhandled).layer),
);

describe(
  "Prisma Compute logs",
  { tags: ["unit", "provider:prisma", "provider:prisma:compute", "local"] },
  () => {
    it.effect("returns an empty tail stream before a version exists", () =>
      Effect.gen(function* () {
        const provider = yield* hostProvider;
        const chunks = yield* Stream.runCollect(
          provider.tail!({
            id: "api",
            fqn: "api",
            instanceId: "00000000000000000000000000000000",
            props: { project: "project-1" },
            output: hostOutput(undefined),
          }),
        );
        expect(chunks).toEqual([]);
      }).pipe(Effect.provide(FetchHttpClient.layer), Effect.provide(PlatformServices)),
    );

    it.effect("tails the version's logs", () =>
      withWebSocketServer((server) =>
        Effect.gen(function* () {
          const url = yield* listenUrl(server);
          let authorization: string | undefined;
          let requestUrl: string | undefined;
          server.on("connection", (socket, request) => {
            authorization = request.headers.authorization;
            requestUrl = request.url;
            socket.send(
              JSON.stringify({ type: "log", text: "compute app log", byteStart: 0, byteEnd: 15 }),
            );
            socket.send(
              JSON.stringify({
                type: "terminal",
                kind: "end",
                code: "vm_stopped",
                message: "done",
                retryable: false,
                cursor: null,
              }),
            );
          });

          const provider = yield* hostProvider;
          const lines = yield* provider.tail!({
            id: "api",
            fqn: "api",
            instanceId: "00000000000000000000000000000000",
            props: { project: "project-1" },
            output: hostOutput("version-1"),
          }).pipe(
            Stream.provideService(
              Credentials,
              Effect.succeed({ apiToken: Redacted.make("app-token"), apiBaseUrl: url }),
            ),
            Stream.runCollect,
          );

          expect(lines.map((line) => line.message)).toEqual(["compute app log"]);
          expect(authorization).toBe("Bearer app-token");
          expect(requestUrl).toBe("/v1/deployments/version-1/logs");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.provide(PlatformServices)),
      ),
    );
  },
);

const withWebSocketServer = <A, E, R>(f: (server: WebSocketServer) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new WebSocketServer({ host: "127.0.0.1", port: 0 })),
    f,
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }).pipe(Effect.ignore),
  );

const listenUrl = (server: WebSocketServer) =>
  Effect.callback<string, Error>((resume) => {
    const complete = () => {
      cleanup();
      const address = server.address();
      if (address && typeof address === "object") {
        resume(Effect.succeed(`http://127.0.0.1:${address.port}`));
      } else {
        resume(Effect.fail(new Error("WebSocket server has no TCP address")));
      }
    };
    const fail = (cause: unknown) => {
      cleanup();
      resume(Effect.fail(cause instanceof Error ? cause : new Error(String(cause))));
    };
    const cleanup = () => {
      server.off("listening", complete);
      server.off("error", fail);
    };
    if (server.address()) {
      complete();
      return;
    }
    server.once("listening", complete);
    server.once("error", fail);
    return Effect.sync(cleanup);
  });
