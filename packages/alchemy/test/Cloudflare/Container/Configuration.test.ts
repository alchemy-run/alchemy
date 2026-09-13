import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import * as Containers from "@distilled.cloud/cloudflare/containers";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Result from "effect/Result";
import {
  application,
  externalApplication,
} from "./fixtures/configuration/application.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const waitGone = (accountId: string, applicationId: string) =>
  Containers.listContainerApplications({ accountId }).pipe(
    Effect.repeat({
      times: 8,
      schedule: Schedule.spaced("1 second"),
      until: (apps) => apps.every((app) => app.id !== applicationId),
    }),
    Effect.tap((apps) =>
      Effect.sync(() =>
        expect(apps.some((app) => app.id === applicationId)).toBe(false),
      ),
    ),
  );

test.provider(
  "container defaults, scaling updates, drift repair and missing recovery",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const initial = yield* stack.deploy(application());
      const { accountId } = initial;
      const read = (applicationId: string) =>
        Containers.getContainerApplication({ accountId, applicationId });
      const actual = yield* read(initial.applicationId);
      expect(actual.maxInstances).toBe(20);
      expect(actual.instances).toBe(0);
      expect(actual.schedulingPolicy).toBe("default");
      expect(initial.configuration.instanceType).toBe("lite");
      expect(actual.configuration.image).toBe(initial.configuration.image);
      const updated = yield* stack.deploy(application({ maxInstances: 2 }));
      expect(updated.applicationId).toBe(initial.applicationId);
      expect((yield* read(updated.applicationId)).maxInstances).toBe(2);
      yield* Containers.updateContainerApplication({
        accountId,
        applicationId: updated.applicationId,
        maxInstances: 3,
      });
      expect((yield* read(updated.applicationId)).maxInstances).toBe(3);
      // Changing only a rollout preference forces reconcile with identical
      // desired scaling/configuration, exposing stale-fingerprint shortcuts.
      const restored = yield* stack.deploy(
        application({ maxInstances: 2, rollout: { strategy: "immediate" } }),
      );
      expect(restored.applicationId).toBe(initial.applicationId);
      expect((yield* read(restored.applicationId)).maxInstances).toBe(2);
      yield* Containers.deleteContainerApplication({
        accountId,
        applicationId: restored.applicationId,
      });
      yield* waitGone(accountId, restored.applicationId);
      const recreated = yield* stack.deploy(application({ maxInstances: 4 }));
      expect(recreated.applicationId).not.toBe(initial.applicationId);
      expect((yield* read(recreated.applicationId)).maxInstances).toBe(4);
      yield* Containers.deleteContainerApplication({
        accountId,
        applicationId: recreated.applicationId,
      });
      yield* waitGone(accountId, recreated.applicationId);
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);

test.provider.skipIf(!process.env.CLOUDFLARE_TEST_CONTAINER_JOBS)(
  "jobs mode survives updates and replacement with a fixed name",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = "alchemy-test-container-jobs-audit";
      const normal = yield* stack.deploy(
        application({ name, jobs: false, maxInstances: 1 }),
      );
      const jobs = yield* stack.deploy(
        application({ name, jobs: true, maxInstances: 1 }),
      );
      expect(jobs.applicationId).not.toBe(normal.applicationId);
      expect(jobs.applicationName).toBe(name);
      const updated = yield* stack.deploy(
        application({ name, jobs: true, maxInstances: 2 }),
      );
      expect(updated.applicationId).toBe(jobs.applicationId);
      expect(
        (yield* Containers.getContainerApplication({
          accountId: jobs.accountId,
          applicationId: jobs.applicationId,
        })).maxInstances,
      ).toBe(2);
      const normalAgain = yield* stack.deploy(
        application({ name, jobs: false, maxInstances: 1 }),
      );
      expect(normalAgain.applicationId).not.toBe(jobs.applicationId);
      yield* stack.destroy();
      yield* waitGone(normalAgain.accountId, normalAgain.applicationId);
    }),
  { timeout: 120_000 },
);

test.provider.skipIf(!!process.env.CLOUDFLARE_TEST_CONTAINER_JOBS)(
  "jobs mode reports its typed account capability requirement",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const source = yield* stack.deploy(application({ maxInstances: 1 }));
      const result = yield* Containers.createContainerApplication({
        accountId: source.accountId,
        name: "alchemy-test-container-jobs-probe",
        jobs: true,
        instances: 0,
        maxInstances: 1,
        schedulingPolicy: "default",
        constraints: {},
        configuration: source.configuration,
      }).pipe(Effect.result);
      if (Result.isSuccess(result)) {
        yield* Containers.deleteContainerApplication({
          accountId: source.accountId,
          applicationId: result.success.id,
        });
      }
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        if (result.failure._tag !== "ContainerJobsNotEnabled")
          return yield* Effect.fail(result.failure);
        expect(result.failure._tag).toBe("ContainerJobsNotEnabled");
      }
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);

test.provider(
  "resolves an explicit Dockerfile relative to its build context",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const app = yield* stack.deploy(externalApplication());
      const actual = yield* Containers.getContainerApplication({
        accountId: app.accountId,
        applicationId: app.applicationId,
      });
      expect(actual.configuration.image).toBe(app.configuration.image);
      expect(actual.maxInstances).toBe(1);
      yield* stack.destroy();
      yield* waitGone(app.accountId, app.applicationId);
    }),
  { timeout: 120_000 },
);
