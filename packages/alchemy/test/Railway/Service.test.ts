import * as railway from "@distilled.cloud/railway";
import * as Provider from "@/Provider";
import * as Railway from "@/Railway";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";

const { test } = Test.make({ providers: Railway.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (serviceId: string) =>
  railway.service({ id: serviceId }).pipe(
    Effect.map((service) =>
      service.deletedAt != null ? ("gone" as const) : ("found" as const),
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

test.provider(
  "create, serve, list, update, and delete an image service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* Railway.Project("Site");
          const api = yield* Railway.Service("Api", {
            project,
            image: "hashicorp/http-echo",
            port: 5678,
          });
          return { project, api };
        }),
      );

      expect(created.api.serviceId).toEqual(expect.any(String));
      expect(created.api.serviceId.length).toBeGreaterThan(0);
      expect(created.api.projectId).toEqual(created.project.projectId);
      expect(created.api.environmentId).toEqual(created.project.environmentId);
      expect(created.api.name).toEqual(expect.any(String));
      expect(created.api.name.length).toBeGreaterThan(0);
      expect(created.api.name.length).toBeLessThanOrEqual(32);
      expect(created.api.name).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(created.api.port).toEqual(5678);
      expect(created.api.domain).toEqual(expect.any(String));
      expect(created.api.domain).toContain("up.railway.app");
      expect(created.api.url).toEqual(`https://${created.api.domain}`);
      expect(created.api.domainId).toEqual(expect.any(String));
      expect(created.api.domainId!.length).toBeGreaterThan(0);

      const fetched = yield* railway.service({ id: created.api.serviceId });
      expect(fetched.id).toEqual(created.api.serviceId);
      expect(fetched.name).toEqual(created.api.name);
      expect(fetched.projectId).toEqual(created.api.projectId);
      expect(fetched.deletedAt).toBeNull();

      const instance = yield* railway.serviceInstance({
        environmentId: created.api.environmentId,
        serviceId: created.api.serviceId,
      });
      expect(instance.serviceId).toEqual(created.api.serviceId);
      expect(instance.environmentId).toEqual(created.api.environmentId);
      expect(instance.source?.image).toEqual(
        expect.stringContaining("hashicorp/http-echo"),
      );

      const domains = yield* railway.domains({
        environmentId: created.api.environmentId,
        projectId: created.api.projectId,
        serviceId: created.api.serviceId,
      });
      const liveDomain = domains.serviceDomains.find(
        (domain) => domain.deletedAt == null && domain.syncStatus !== "DELETED",
      );
      expect(liveDomain).toBeDefined();
      expect(liveDomain?.domain).toEqual(created.api.domain);
      expect(liveDomain?.targetPort).toEqual(5678);

      const provider = yield* Provider.findProvider(Railway.Service);
      const listed = yield* provider.list();
      const found = listed.find(
        (service) => service.serviceId === created.api.serviceId,
      );
      expect(found).toBeDefined();
      expect(found?.name).toEqual(created.api.name);
      expect(found?.projectId).toEqual(created.api.projectId);

      const client = yield* HttpClient.HttpClient;
      const body = yield* client.get(created.api.url!).pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? res.text
            : Effect.fail(new Error(`api returned ${res.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.spaced("4 seconds"),
          times: 10,
        }),
      );
      expect(typeof body).toEqual("string");
      expect(body.length).toBeGreaterThan(0);

      const nextName =
        created.api.name.slice(0, -1) +
        (created.api.name.endsWith("z") ? "y" : "z");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* Railway.Project("Site");
          const api = yield* Railway.Service("Api", {
            project,
            image: "hashicorp/http-echo",
            port: 5678,
            name: nextName,
          });
          return { project, api };
        }),
      );

      expect(updated.api.serviceId).toEqual(created.api.serviceId);
      expect(updated.api.name).toEqual(nextName);
      expect(updated.api.projectId).toEqual(created.api.projectId);
      expect(updated.api.url).toEqual(created.api.url);

      const fetchedUpdate = yield* railway.service({
        id: updated.api.serviceId,
      });
      expect(fetchedUpdate.id).toEqual(updated.api.serviceId);
      expect(fetchedUpdate.name).toEqual(nextName);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.api.serviceId);
      expect(gone).toEqual("gone");
      const projectGone = yield* waitUntilProjectGone(
        created.project.projectId,
      );
      expect(projectGone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
