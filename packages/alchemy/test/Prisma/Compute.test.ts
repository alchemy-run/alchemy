import {
  createDeploymentStart,
  createEnvironmentVariable,
  createService,
  createServiceDeployment,
  createServicePromote,
  deleteEnvironmentVariable,
  deleteService,
  getDeployment,
  getService,
  getServiceDeployments,
  getServices,
} from "@distilled.cloud/prisma/management";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { OwnedBySomeoneElse } from "@/AdoptPolicy";
import * as Drift from "@/Drift.ts";
import * as Prisma from "@/Prisma";
import { Compute, waitForDeploymentUrl } from "@/Prisma/Compute";
import { waitForDeploymentStatus } from "@/Prisma/ComputeLifecycle";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import {
  deletedDeploymentId,
  deploymentIds,
  environmentKeys,
  expectDeploymentGone,
  expectLatestDeployment,
  expectServes,
  expectServiceGone,
  faultServerDir,
  latestDeploymentId,
  nestAppDir,
  patchAttr,
} from "./fixtures/ComputeLive.ts";
import { expectProjectGone, failureOf } from "./fixtures/Live.ts";

/** Serve `fetch` on an ephemeral local port for the scope; yields its origin. */
const localServer = (fetch: (request: Request) => Response) =>
  Effect.acquireRelease(
    Effect.sync(() => Bun.serve({ hostname: "127.0.0.1", port: 0, fetch })),
    (server) => Effect.sync(() => server.stop(true)),
  ).pipe(Effect.map((server) => `http://127.0.0.1:${server.port}`));

/** Accept TCP connections and never answer them; yields an HTTP origin. */
const silentServer = Effect.acquireRelease(
  Effect.sync(() => Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })),
  (listener) => Effect.sync(() => listener.stop(true)),
).pipe(Effect.map((listener) => `http://127.0.0.1:${listener.port}`));

/**
 * A response body that sends one chunk (so the server flushes the status
 * line) and then never produces another or closes.
 */
const endlessBody = () =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(" "));
    },
    pull() {
      // Deliberately never enqueue or close.
    },
  });

const props = { project: "project-1", appName: "api" } as const;

describe(
  "Prisma Compute URL readiness",
  { tags: ["unit", "provider:prisma", "provider:prisma:compute", "local"] },
  () => {
    it.live("accepts a streaming 200 response without consuming its body", () =>
      Effect.gen(function* () {
        const url = yield* localServer(() => new Response(endlessBody(), { status: 200 }));
        yield* waitForDeploymentUrl(url, { ...props, urlReadinessTimeoutSeconds: 5 });
      }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
    );

    it.live("waits for the configured application health contract", () =>
      Effect.gen(function* () {
        const requests: string[] = [];
        const url = yield* localServer((request) => {
          requests.push(new URL(request.url).pathname);
          return new Response(null, { status: requests.length === 1 ? 503 : 204 });
        });

        yield* waitForDeploymentUrl(url, {
          ...props,
          healthCheck: { path: "/api/health" },
          pollIntervalMs: 10,
          urlReadinessTimeoutSeconds: 30,
        });

        expect(requests).toEqual(["/api/health", "/api/health"]);
      }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
    );

    it.effect("rejects unsafe application health contracts", () =>
      Effect.gen(function* () {
        const pathError = yield* waitForDeploymentUrl("https://app.prisma.build", {
          ...props,
          healthCheck: { path: "//attacker.example/health" },
        }).pipe(Effect.flip);
        const statusError = yield* waitForDeploymentUrl("https://app.prisma.build", {
          ...props,
          healthCheck: { path: "/health", statusCodes: [] },
        }).pipe(Effect.flip);

        expect(pathError.message).toContain("healthCheck.path");
        expect(statusError.message).toContain("healthCheck.statusCodes");
      }),
    );

    it.effect("fails closed when an application health probe cannot run", () =>
      Effect.gen(function* () {
        const health = { ...props, healthCheck: { path: "/health" } } as const;
        const missingUrl = yield* waitForDeploymentUrl(undefined, health).pipe(Effect.flip);
        const missingRoutingUrl = yield* waitForDeploymentUrl(undefined, props).pipe(Effect.flip);
        const disabled = yield* waitForDeploymentUrl("https://app.prisma.build", {
          ...health,
          verifyUrl: false,
        }).pipe(Effect.flip);
        // No HttpClient service is provided here.
        const missingClient = yield* waitForDeploymentUrl("https://app.prisma.build", health).pipe(
          Effect.flip,
        );

        expect(missingUrl.message).toContain("did not return");
        expect(missingRoutingUrl.message).toContain("readiness verification");
        expect(disabled.message).toContain("verifyUrl: false");
        expect(missingClient.message).toContain("HTTP client");
      }),
    );

    it.live("observes health redirects without following them", () =>
      Effect.gen(function* () {
        let followed = 0;
        const url = yield* localServer((request) => {
          if (new URL(request.url).pathname === "/health") {
            return new Response(null, { status: 302, headers: { location: "/followed" } });
          }
          followed += 1;
          return new Response("followed", { status: 200 });
        });

        yield* waitForDeploymentUrl(url, {
          ...props,
          healthCheck: { path: "/health", statusCodes: [302] },
          pollIntervalMs: 10,
          urlReadinessTimeoutSeconds: 5,
        });
        const defaultStatusError = yield* waitForDeploymentUrl(url, {
          ...props,
          healthCheck: { path: "/health" },
          pollIntervalMs: 10,
          urlReadinessTimeoutSeconds: 0.5,
        }).pipe(Effect.flip);

        expect(defaultStatusError.message).toContain("HTTP 302");
        expect(followed).toBe(0);
      }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
    );

    it.live("enforces one deadline for stalled requests and 404 bodies", () =>
      Effect.gen(function* () {
        const stalledRequest = yield* silentServer;
        const stalledBody = yield* localServer(() => new Response(endlessBody(), { status: 404 }));
        const timing = { ...props, pollIntervalMs: 10, urlReadinessTimeoutSeconds: 0.5 } as const;

        const requestError = yield* waitForDeploymentUrl(stalledRequest, timing).pipe(Effect.flip);
        const bodyError = yield* waitForDeploymentUrl(stalledBody, timing).pipe(Effect.flip);

        expect(requestError.message).toContain("Timed out");
        expect(requestError.message).toContain("No HTTP response");
        expect(bodyError.message).toContain("Timed out");
        expect(bodyError.message).toContain("HTTP 404");
      }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
    );

    it.live("bounds the inspected prefix of a large Prisma edge 404", () =>
      Effect.gen(function* () {
        const hugeBody = `There is no service on this URL${"x".repeat(256 * 1024)}`;
        const url = yield* localServer(() => new Response(hugeBody, { status: 404 }));

        const error = yield* waitForDeploymentUrl(url, {
          ...props,
          pollIntervalMs: 10,
          urlReadinessTimeoutSeconds: 1,
        }).pipe(Effect.flip);

        expect(error.message).toContain("There is no service on this URL");
      }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
    );

    it.live("rejects invalid URL readiness timings before making a request", () =>
      Effect.gen(function* () {
        let requests = 0;
        const url = yield* localServer(() => {
          requests += 1;
          return new Response("ok");
        });

        const error = yield* waitForDeploymentUrl(url, { ...props, pollIntervalMs: 0 }).pipe(
          Effect.flip,
        );

        expect(error.message).toContain("pollIntervalMs");
        expect(requests).toBe(0);
      }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
    );
  },
);

const { test } = Test.make({ providers: Prisma.providers() });

const liveTags = ["provider:prisma", "provider:prisma:compute", "provider:prisma:project", "live"];

const projectOnly = Effect.gen(function* () {
  const project = yield* Prisma.Project("Project", { createDatabase: false });
  return { project, app: undefined };
});

/**
 * The fault server as an App whose health check targets this generation.
 * Readiness waits are short because several steps expect them to fail.
 */
const faultApp = (
  greeting: string,
  options: {
    env?: Record<string, string>;
    statusCodes?: number[];
    timeoutSeconds?: number;
  } = {},
) =>
  Effect.gen(function* () {
    const project = yield* Prisma.Project("Project", { createDatabase: false });
    const app = yield* Prisma.Compute("App", {
      project,
      path: faultServerDir,
      entrypoint: "server.ts",
      env: { GREETING: greeting, ...options.env },
      healthCheck: {
        path: `/health/${greeting}`,
        ...(options.statusCodes === undefined ? {} : { statusCodes: options.statusCodes }),
      },
      timeoutSeconds: options.timeoutSeconds ?? 120,
      urlReadinessTimeoutSeconds: 15,
    });
    return { project, app };
  });

test.provider(
  "gates promotion on preview and stable health, rolls back, and deletes an App whose first deployment never became healthy",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();
    const { project } = yield* stack.deploy(projectOnly);
    const projectId = project.projectId;

    // A first deployment that crashes on boot never passes preview health:
    // the App created for it and the variables written for it are removed.
    const crashed = yield* failureOf(
      stack.deploy(faultApp("boot", { env: { CRASH_ON_BOOT: "1" } })),
    );
    expect(crashed.text).toContain("/health/boot");
    expect((yield* getServices({ projectId, limit: 100 })).data).toEqual([]);
    expect(yield* environmentKeys(projectId, "production")).toEqual([]);

    // Custom accepted statuses apply before and after promotion.
    const v1 = (yield* stack.deploy(
      faultApp("one", { env: { HEALTH_STATUS: "302" }, statusCodes: [302] }),
    )).app;
    expect(v1.promoted).toBe(true);
    expect(v1.readinessStatus).toBe("ready");
    expect(v1.previousDeploymentId).toBeNull();
    yield* expectServes(`${v1.url}/`, "one");

    // Preview health fails: no promotion, and the new deployment is deleted.
    const preview = yield* failureOf(
      stack.deploy(faultApp("two", { env: { HEALTH_STATUS: "503" } })),
    );
    expect(preview.text).toMatch(/https:\/\/cv-[^\s']+\/health\/two/);
    expect(preview.text).toContain("HTTP 503");
    expect(yield* latestDeploymentId(v1.appId)).toBe(v1.deploymentId);
    expect(yield* deploymentIds(v1.appId)).toEqual([v1.deploymentId]);
    yield* expectServes(`${v1.url}/`, "one");

    // Stable health fails after promotion: roll back, then delete the new deployment.
    const stable = yield* failureOf(
      stack.deploy(faultApp("three", { env: { STABLE_HEALTH_STATUS: "503" } })),
    );
    expect(stable.text).toContain(`${v1.url}/health/three`);
    expect(stable.text).toContain("HTTP 503");
    yield* expectLatestDeployment(v1.appId, v1.deploymentId!);
    expect(yield* deploymentIds(v1.appId)).toEqual([v1.deploymentId]);
    yield* expectServes(`${v1.url}/`, "one");

    yield* stack.destroy();
    yield* expectServiceGone(v1.appId);
    yield* expectProjectGone(projectId);
  }),
  { tags: liveTags, timeout: 300_000 },
);

test.provider(
  "reports a promotion lost out of band, restores it before changing anything, and drains pending cleanup",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();
    const recoveryApp = (greeting: string) => faultApp(greeting, { timeoutSeconds: 30 });

    const v1 = (yield* stack.deploy(recoveryApp("one"))).app;
    const appId = v1.appId;

    // Another actor promotes a fork of the live code.
    const fork = (yield* createServiceDeployment({ serviceId: appId, skipCodeUpload: true })).data;
    yield* createDeploymentStart({ deploymentId: fork.id });
    yield* waitForDeploymentStatus(fork.id, "running", { timeoutSeconds: 60 });
    yield* createServicePromote({ serviceId: appId, deploymentId: fork.id });
    yield* expectLatestDeployment(appId, fork.id);

    // Refresh reads the stored deployment, which is no longer promoted.
    const detected = yield* Drift.detect({ name: stack.name, stage: stack.stage }).pipe(
      Effect.provide(stack.state),
    );
    expect(detected.resources.App).toMatchObject({
      action: "drifted",
      attr: {
        appId,
        deploymentId: v1.deploymentId,
        promoted: false,
        url: v1.deploymentUrl,
      },
    });

    // The stored generation is gone: recovery cannot restore it, so nothing changes.
    yield* patchAttr(stack, "App", { deploymentId: yield* deletedDeploymentId(appId) });
    const blocked = yield* failureOf(stack.deploy(recoveryApp("two")));
    expect(blocked.text).toContain("no environment variables or new deployment were changed");
    expect(yield* latestDeploymentId(appId)).toBe(fork.id);
    expect(yield* deploymentIds(appId)).toEqual([v1.deploymentId, fork.id].sort());

    // With the stored generation intact, the next deploy restores it, deletes
    // the displaced fork, and only then creates its own generation.
    yield* patchAttr(stack, "App", { deploymentId: v1.deploymentId });
    const recovered = (yield* stack.deploy(recoveryApp("two"))).app;
    expect([v1.deploymentId, fork.id]).not.toContain(recovered.deploymentId);
    expect(recovered.promoted).toBe(true);
    expect(recovered.previousDeploymentId).toBe(v1.deploymentId);
    expect(recovered.previousDeploymentAction).toBe("stopped");
    yield* expectDeploymentGone(fork.id);
    expect((yield* getDeployment({ deploymentId: v1.deploymentId! })).data.status).toBe("stopped");
    yield* expectServes(`${recovered.url}/`, "two");

    // A cleanup persisted as pending is drained first; the unchanged
    // generation is reused and its promotion replayed.
    yield* patchAttr(stack, "App", {
      pendingDeploymentCleanup: { deploymentId: v1.deploymentId, action: "destroy" },
    });
    const drained = (yield* stack.deploy(recoveryApp("two"))).app;
    expect(drained.deploymentId).toBe(recovered.deploymentId);
    expect(drained.promoted).toBe(true);
    expect(drained.pendingDeploymentCleanup).toBeUndefined();
    yield* expectDeploymentGone(v1.deploymentId!);
    expect(yield* deploymentIds(appId)).toEqual([recovered.deploymentId]);

    yield* stack.destroy();
    yield* expectServiceGone(appId);
    yield* expectProjectGone(v1.projectId);
  }),
  { tags: liveTags, timeout: 300_000 },
);

test.provider(
  "refuses foreign and mismatched Apps, maps framework ports, tails logs, and deletes owned env on removal",
  Effect.fn(function* (stack: Test.ScratchStack) {
    const fs = yield* FileSystem.FileSystem;
    yield* stack.destroy();
    const nestDir = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-prisma-compute-nest-" });
    yield* fs.copy(nestAppDir, nestDir);

    const program = (
      options: {
        app?: { appName: string; env?: Record<string, string | Redacted.Redacted | null> };
        nest?: boolean;
      } = {},
    ) =>
      Effect.gen(function* () {
        const project = yield* Prisma.Project("Project", { createDatabase: false });
        const other = yield* Prisma.Project("Other", { createDatabase: false });
        const app = options.app
          ? yield* Prisma.Compute("App", {
              project,
              appName: options.app.appName,
              path: faultServerDir,
              entrypoint: "server.ts",
              port: 3000,
              env: { GREETING: "owned", ...options.app.env },
              timeoutSeconds: 120,
            })
          : undefined;
        const nest = options.nest
          ? yield* Prisma.Compute("Nest", {
              project,
              path: nestDir,
              build: { type: "auto", framework: "nestjs" },
              timeoutSeconds: 120,
            })
          : undefined;
        return { project, other, app, nest };
      });

    const base = yield* stack.deploy(program());
    const projectId = base.project.projectId;
    const otherId = base.other.projectId;

    // An App another actor created under the requested name is never claimed.
    const foreign = (yield* createService({
      projectId,
      displayName: "taken",
      branchGitName: "main",
    })).data;
    const claimed = yield* failureOf(stack.deploy(program({ app: { appName: "taken" } })));
    expect(claimed.errors.some((error) => error instanceof OwnedBySomeoneElse)).toBe(true);
    expect((yield* getService({ serviceId: foreign.id })).data.name).toBe("taken");
    expect((yield* getServiceDeployments({ serviceId: foreign.id })).data).toEqual([]);
    yield* deleteService({ serviceId: foreign.id });
    yield* expectServiceGone(foreign.id);

    const deployed = yield* stack.deploy(
      program({
        app: { appName: "owned", env: { TOKEN: Redacted.make("secret"), STALE_FLAG: null } },
        nest: true,
      }),
    );
    const app = deployed.app!;
    const nest = deployed.nest!;
    expect(app.environmentKeys).toEqual(["GREETING", "TOKEN"]);
    // The explicit port is mapped and handed to the process.
    expect((yield* getDeployment({ deploymentId: app.deploymentId! })).data.portMapping).toEqual({
      http: 3000,
    });
    yield* expectServes(`${app.url}/env?key=PORT`, "3000");
    // A framework build maps the framework's default port.
    expect((yield* getDeployment({ deploymentId: nest.deploymentId! })).data.portMapping).toEqual({
      http: 3000,
    });
    yield* expectServes(`${nest.url}/`, "nest-default-port");

    // Logs stream from the deployment through the provider.
    const provider = yield* Provider.findProvider(Compute);
    const tailInput = {
      id: "App",
      fqn: "App",
      instanceId: "00000000000000000000000000000000",
      props: { project: projectId, appName: app.appName },
    };
    expect(
      Array.from(
        yield* provider.tail!({ ...tailInput, output: { ...app, deploymentId: undefined } }).pipe(
          Stream.runCollect,
        ),
      ),
    ).toEqual([]);
    const tailed = yield* provider.tail!({ ...tailInput, output: app }).pipe(
      Stream.filter((line) => line.message.includes("fault-server owned")),
      Stream.take(1),
      Stream.runCollect,
      Effect.timeout("60 seconds"),
      Effect.forkChild,
    );
    const traffic = yield* HttpClient.get(`${app.url}/`).pipe(
      Effect.flatMap((response) => response.text),
      Effect.ignore,
      Effect.repeat({ schedule: Schedule.spaced("2 seconds"), times: 30 }),
      Effect.forkChild,
    );
    const lines = Array.from(yield* Fiber.join(tailed));
    yield* Fiber.interrupt(traffic);
    expect(lines[0]?.message).toContain("fault-server owned");

    // A persisted App ID that resolves to an App in another project is refused.
    const mismatched = (yield* createService({
      projectId: otherId,
      displayName: "owned",
      branchGitName: "main",
    })).data;
    yield* patchAttr(stack, "App", { appId: mismatched.id });
    const refused = yield* failureOf(
      stack.deploy(
        program({
          app: { appName: "owned", env: { TOKEN: Redacted.make("secret"), STALE_FLAG: null } },
          nest: true,
        }),
      ),
    );
    expect(refused.text).toContain("Refusing to patch");
    expect(refused.text).toContain(otherId);
    expect((yield* getServiceDeployments({ serviceId: mismatched.id })).data).toEqual([]);
    yield* patchAttr(stack, "App", { appId: app.appId });
    yield* deleteService({ serviceId: mismatched.id });

    // Removal deletes every variable state records as owned, including a
    // key the props tombstone, and tolerates one that is already gone.
    const stale = (yield* createEnvironmentVariable({
      projectId,
      class: "production",
      key: "STALE_FLAG",
      value: "stale",
    })).data;
    yield* deleteEnvironmentVariable({ envVarId: app.environmentVariableIds!.TOKEN! });
    yield* patchAttr(stack, "App", {
      environmentVariableIds: { ...app.environmentVariableIds, STALE_FLAG: stale.id },
    });
    yield* stack.deploy(program());
    yield* expectServiceGone(app.appId);
    yield* expectServiceGone(nest.appId);
    expect(yield* environmentKeys(projectId, "production")).toEqual([]);

    yield* stack.destroy();
    yield* expectProjectGone(projectId);
    yield* expectProjectGone(otherId);
  }),
  { tags: [...liveTags, "provider:prisma:environment-variable"], timeout: 300_000 },
);

const dev = Test.make({ providers: Prisma.providers(), dev: true });

dev.test.provider(
  "dev provider applies the same Compute prop validation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const failed = yield* failureOf(
        stack.deploy(
          Compute("App", {
            project: "project-dev",
            appName: "api",
            skipPromote: true,
            destroyOldDeployment: true,
            dev: { url: "http://localhost:3000" },
          }),
        ),
      );

      expect(failed.text).toContain("destroyOldDeployment cannot be combined with skipPromote");

      yield* stack.destroy();
    }),
  { tags: ["unit", "provider:prisma", "provider:prisma:compute", "local"] },
);
