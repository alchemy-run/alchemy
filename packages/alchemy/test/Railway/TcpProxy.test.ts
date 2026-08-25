import * as railway from "@distilled.cloud/railway";
import * as Railway from "@/Railway";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Railway.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const listLive = (environmentId: string, serviceId: string) =>
  railway.tcpProxies({ environmentId, serviceId }).pipe(
    Effect.map((items) =>
      items
        .filter(
          (proxy) => proxy.deletedAt == null && proxy.syncStatus !== "DELETED",
        )
        .map((proxy) => ({
          ...proxy,
          domain: proxy.domain.replace(/\.+$/, ""),
        })),
    ),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () => Effect.succeed([])),
  );

const waitUntilProxyGone = (
  environmentId: string,
  serviceId: string,
  id: string,
) =>
  listLive(environmentId, serviceId).pipe(
    Effect.map((items) =>
      items.some((proxy) => proxy.id === id)
        ? ("found" as const)
        : ("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const waitUntilProjectGone = (projectId: string) =>
  railway.project({ id: projectId }).pipe(
    Effect.map((project) =>
      project.deletedAt != null ? ("gone" as const) : ("found" as const),
    ),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const createTargetService = (projectId: string, environmentId: string) =>
  railway.serviceCreate({
    input: {
      projectId,
      environmentId,
      name: "tcp-target",
      source: { image: "redis:7-alpine" },
    },
  });

test.provider(
  "create, update, and delete a tcp proxy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const project = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Railway.Project("Site");
        }),
      );

      const service = yield* createTargetService(
        project.projectId,
        project.environmentId,
      );

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const site = yield* Railway.Project("Site");
          const proxy = yield* Railway.TcpProxy("DbProxy", {
            service: { serviceId: service.id },
            environment: site,
            applicationPort: 6379,
          });
          return { project: site, proxy };
        }),
      );

      expect(created.proxy.id).toEqual(expect.any(String));
      expect(created.proxy.id.length).toBeGreaterThan(0);
      expect(created.proxy.domain).toEqual(expect.any(String));
      expect(created.proxy.domain.length).toBeGreaterThan(0);
      expect(created.proxy.proxyPort).toEqual(expect.any(Number));
      expect(created.proxy.proxyPort).toBeGreaterThan(0);
      expect(created.proxy.applicationPort).toEqual(6379);
      expect(created.proxy.serviceId).toEqual(service.id);
      expect(created.proxy.environmentId).toEqual(project.environmentId);

      const listed = yield* listLive(project.environmentId, service.id);
      const fetched = listed.find((proxy) => proxy.id === created.proxy.id);
      expect(fetched).toBeDefined();
      expect(fetched?.domain).toEqual(created.proxy.domain);
      expect(fetched?.proxyPort).toEqual(created.proxy.proxyPort);
      expect(fetched?.applicationPort).toEqual(6379);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const site = yield* Railway.Project("Site");
          const proxy = yield* Railway.TcpProxy("DbProxy", {
            service: { serviceId: service.id },
            environment: site,
            applicationPort: 6379,
          });
          return { project: site, proxy };
        }),
      );

      expect(updated.proxy.id).toEqual(created.proxy.id);
      expect(updated.proxy.domain).toEqual(created.proxy.domain);
      expect(updated.proxy.proxyPort).toEqual(created.proxy.proxyPort);
      expect(updated.proxy.applicationPort).toEqual(6379);
      expect(updated.project.projectId).toEqual(project.projectId);

      yield* stack.destroy();

      const proxyGone = yield* waitUntilProxyGone(
        project.environmentId,
        service.id,
        created.proxy.id,
      );
      expect(proxyGone).toEqual("gone");
      const projectGone = yield* waitUntilProjectGone(project.projectId);
      expect(projectGone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 480_000 },
);

test.provider(
  "replace when applicationPort changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const project = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Railway.Project("Site");
        }),
      );

      const service = yield* createTargetService(
        project.projectId,
        project.environmentId,
      );

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const site = yield* Railway.Project("Site");
          const proxy = yield* Railway.TcpProxy("DbProxy", {
            postgres: { serviceId: service.id },
            environment: site,
            applicationPort: 6379,
          });
          return { project: site, proxy };
        }),
      );

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const site = yield* Railway.Project("Site");
          const proxy = yield* Railway.TcpProxy("DbProxy", {
            postgres: { serviceId: service.id },
            environment: site,
            applicationPort: 5432,
          });
          return { project: site, proxy };
        }),
      );

      expect(replaced.proxy.applicationPort).toEqual(5432);
      expect(replaced.proxy.id).not.toEqual(created.proxy.id);
      expect(replaced.proxy.domain).toEqual(expect.any(String));
      expect(replaced.proxy.proxyPort).toEqual(expect.any(Number));

      const listed = yield* listLive(project.environmentId, service.id);
      const next = listed.find((proxy) => proxy.id === replaced.proxy.id);
      expect(next).toBeDefined();
      expect(next?.applicationPort).toEqual(5432);
      expect(listed.some((proxy) => proxy.id === created.proxy.id)).toEqual(
        false,
      );

      yield* stack.destroy();

      const proxyGone = yield* waitUntilProxyGone(
        project.environmentId,
        service.id,
        replaced.proxy.id,
      );
      expect(proxyGone).toEqual("gone");
      const projectGone = yield* waitUntilProjectGone(project.projectId);
      expect(projectGone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 480_000 },
);
