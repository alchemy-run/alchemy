import * as railway from "@distilled.cloud/railway";
import * as Provider from "@/Provider";
import * as Railway from "@/Railway";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import Ping from "./fixtures/ping.ts";

const { test } = Test.make({ providers: Railway.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const HTTP_SOURCE = `
Bun.serve({
  hostname: "0.0.0.0",
  port: Number(process.env.PORT ?? 3000),
  fetch() {
    return new Response("ok");
  },
});
`;

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
  "create, list, and delete a canvas Function",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* Railway.Project("Site");
          const ping = yield* Railway.Function("Ping", {
            project,
            source: HTTP_SOURCE,
          });
          const job = yield* Railway.Function("Cleanup", {
            project,
            source: `console.log("tick");`,
            cronSchedule: "0 * * * *",
          });
          return { project, ping, job };
        }),
      );

      expect(created.ping.serviceId).toEqual(expect.any(String));
      expect(created.ping.serviceId.length).toBeGreaterThan(0);
      expect(created.ping.projectId).toEqual(created.project.projectId);
      expect(created.ping.environmentId).toEqual(created.project.environmentId);
      expect(created.ping.name).toEqual(expect.any(String));
      expect(created.ping.name.length).toBeGreaterThan(0);
      expect(created.ping.name.length).toBeLessThanOrEqual(32);
      expect(created.ping.name).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(created.ping.runtime).toEqual("bun");
      expect(created.ping.image).toEqual(expect.any(String));
      expect(Railway.isFunctionImage(created.ping.image)).toEqual(true);
      expect(created.ping.code.hash).toEqual(expect.any(String));
      expect(created.ping.code.hash.length).toBeGreaterThan(0);
      expect(created.ping.domain).toEqual(expect.any(String));
      expect(created.ping.domain).toContain("up.railway.app");
      expect(created.ping.url).toEqual(`https://${created.ping.domain}`);
      expect(created.ping.dnsName).toEqual(
        `${created.ping.name}.railway.internal`,
      );
      expect(created.ping.rpcToken.length).toBeGreaterThanOrEqual(32);
      expect(created.ping.domainId).toEqual(expect.any(String));
      expect(created.ping.domainId!.length).toBeGreaterThan(0);

      const fetched = yield* railway.service({ id: created.ping.serviceId });
      expect(fetched.id).toEqual(created.ping.serviceId);
      expect(fetched.name).toEqual(created.ping.name);
      expect(fetched.projectId).toEqual(created.ping.projectId);
      expect(fetched.deletedAt).toBeNull();

      const instance = yield* railway.serviceInstance({
        environmentId: created.ping.environmentId,
        serviceId: created.ping.serviceId,
      });
      expect(instance.serviceId).toEqual(created.ping.serviceId);
      expect(instance.environmentId).toEqual(created.ping.environmentId);
      expect(Railway.isFunctionImage(instance.source?.image)).toEqual(true);
      expect(instance.startCommand).toEqual(
        expect.stringMatching(/^\.\/run\.sh /),
      );

      const runtime = yield* railway.functionRuntime({ name: "bun" });
      expect(runtime.name).toEqual("bun");
      expect(runtime.latestVersion.image.length).toBeGreaterThan(0);
      expect(instance.source?.image).toEqual(runtime.latestVersion.image);

      const provider = yield* Provider.findProvider(Railway.Function);
      const listed = yield* provider.list();
      const found = listed.find(
        (fn) => fn.serviceId === created.ping.serviceId,
      );
      expect(found).toBeDefined();
      expect(found?.name).toEqual(created.ping.name);
      expect(found?.projectId).toEqual(created.ping.projectId);
      expect(Railway.isFunctionImage(found?.image)).toEqual(true);

      const client = yield* HttpClient.HttpClient;
      const body = yield* client.get(created.ping.url!).pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? res.text
            : Effect.fail(new Error(`function returned ${res.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.spaced("4 seconds"),
          times: 10,
        }),
      );
      expect(body).toEqual("ok");

      expect(created.job.serviceId).toEqual(expect.any(String));
      expect(created.job.cronSchedule).toEqual("0 * * * *");
      expect(created.job.url).toBeUndefined();
      expect(created.job.domain).toBeUndefined();
      const jobInstance = yield* railway.serviceInstance({
        environmentId: created.job.environmentId,
        serviceId: created.job.serviceId,
      });
      expect(jobInstance.cronSchedule).toEqual("0 * * * *");
      expect(Railway.isFunctionImage(jobInstance.source?.image)).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.ping.serviceId);
      expect(gone).toEqual("gone");
      const projectGone = yield* waitUntilProjectGone(
        created.project.projectId,
      );
      expect(projectGone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 480_000 },
);

test.provider(
  "create, serve, and delete an Effect-native Function",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const ping = yield* Ping;
          return { ping };
        }),
      );

      expect(created.ping.serviceId).toEqual(expect.any(String));
      expect(created.ping.runtime).toEqual("bun");
      expect(Railway.isFunctionImage(created.ping.image)).toEqual(true);
      expect(created.ping.code.hash).toEqual(expect.any(String));
      expect(created.ping.domain).toContain("up.railway.app");
      expect(created.ping.url).toEqual(`https://${created.ping.domain}`);
      expect(created.ping.dnsName).toEqual(
        `${created.ping.name}.railway.internal`,
      );
      expect(created.ping.rpcToken.length).toBeGreaterThanOrEqual(32);

      const instance = yield* railway.serviceInstance({
        environmentId: created.ping.environmentId,
        serviceId: created.ping.serviceId,
      });
      expect(Railway.isFunctionImage(instance.source?.image)).toEqual(true);
      expect(instance.startCommand).toEqual(
        expect.stringMatching(/^\.\/run\.sh /),
      );

      const client = yield* HttpClient.HttpClient;
      const body = yield* client.get(created.ping.url!).pipe(
        Effect.timeout("10 seconds"),
        Effect.flatMap((res) =>
          res.status === 200
            ? res.text
            : res.text.pipe(
                Effect.flatMap((text) =>
                  Effect.fail(
                    new Error(`function returned ${res.status}: ${text}`),
                  ),
                ),
              ),
        ),
        Effect.retry({
          schedule: Schedule.spaced("3 seconds"),
          times: 5,
        }),
      );
      expect(body).toEqual("ok");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.ping.serviceId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 180_000 },
);
