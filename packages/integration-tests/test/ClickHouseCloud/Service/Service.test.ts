import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";
import { assert, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as organization from "@distilled.cloud/clickhouse-cloud/organization";
import * as service from "@distilled.cloud/clickhouse-cloud/service";
import { DestroyError } from "alchemy/Apply";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { cleanSlate } from "../fixtures/cleanup.ts";

const { test } = Test.make({ providers: ClickHouseCloud.providers() });

// A service takes minutes to create, stop and delete, and bills compute
// while it runs (the smallest service, about $0.11 a run). Set
// CLICKHOUSE_CLOUD_TEST_SLOW=1 to run it.
const slow = !process.env.CLICKHOUSE_CLOUD_TEST_SLOW;

const getService = (serviceId: string) =>
  Effect.gen(function* () {
    const organizationId = yield* ClickHouseCloud.organizationId;
    return yield* service.getService({ organizationId, serviceId }).pipe(
      Effect.map(({ result }) => result),
      Effect.catchTag("NotFound", () => Effect.undefined),
    );
  });

const small = {
  provider: "aws" as const,
  region: "us-east-1" as const,
  minReplicaMemoryGb: 8,
  maxReplicaMemoryGb: 8,
  numReplicas: 1,
  idleScaling: true,
  idleTimeoutMinutes: 5,
};

test.provider.skipIf(slow)(
  "create a service, update it in place, stop it, delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* cleanSlate(stack);

      const created = yield* stack.deploy(
        ClickHouseCloud.Service.Service("Analytics", {
          ...small,
          ipAccessList: [{ source: "203.0.113.0/24", description: "office" }],
          tags: { team: "data" },
        }),
      );
      expect(created.state).toEqual("running");
      expect(created.httpsUrl).toMatch(/^https:\/\/.+:8443$/);
      expect(Redacted.value(created.password!).length).toBeGreaterThan(0);
      expect(created.tags).toMatchObject({ team: "data", "alchemy.id": "Analytics" });
      const observed = yield* getService(created.serviceId);
      expect(observed?.ipAccessList).toEqual([{ source: "203.0.113.0/24", description: "office" }]);

      // Access list, tags and idle timeout update the same service; the
      // generated password is kept.
      const updated = yield* stack.deploy(
        ClickHouseCloud.Service.Service("Analytics", {
          ...small,
          idleTimeoutMinutes: 10,
          ipAccessList: [{ source: "198.51.100.7", description: "ci" }],
          tags: { team: "platform" },
        }),
      );
      expect(updated.serviceId).toEqual(created.serviceId);
      expect(Redacted.value(updated.password!)).toEqual(Redacted.value(created.password!));
      const afterUpdate = yield* getService(created.serviceId);
      expect(afterUpdate?.ipAccessList).toEqual([{ source: "198.51.100.7", description: "ci" }]);
      expect(afterUpdate?.idleTimeoutMinutes).toEqual(10);
      expect(afterUpdate?.tags).toContainEqual({ key: "team", value: "platform" });
      expect(afterUpdate?.tags).not.toContainEqual({ key: "team", value: "data" });

      // A password prop replaces the generated one, in place.
      const password = Redacted.make("Alchemy-Test-Password-1!");
      const withPassword = yield* stack.deploy(
        ClickHouseCloud.Service.Service("Analytics", {
          ...small,
          idleTimeoutMinutes: 10,
          ipAccessList: [{ source: "198.51.100.7", description: "ci" }],
          tags: { team: "platform" },
          password,
        }),
      );
      expect(withPassword.serviceId).toEqual(created.serviceId);
      expect(Redacted.value(withPassword.password!)).toEqual(Redacted.value(password));

      // Desired state `stopped` stops it.
      const stopped = yield* stack.deploy(
        ClickHouseCloud.Service.Service("Analytics", {
          ...small,
          idleTimeoutMinutes: 10,
          ipAccessList: [{ source: "198.51.100.7", description: "ci" }],
          tags: { team: "platform" },
          password,
          state: "stopped",
        }),
      );
      expect(stopped.state).toEqual("stopped");
      expect((yield* getService(created.serviceId))?.state).toEqual("stopped");

      // Destroy deletes the stopped service.
      yield* stack.destroy();
      // Destroy waits until the service is gone.
      expect(yield* getService(created.serviceId)).toBeUndefined();
    }).pipe(Effect.scoped),
  { tags: ["provider:clickhouse-cloud", "live"], timeout: 3_600_000 },
);

test.provider.skipIf(slow)(
  "a region change replaces the service and deletes the old one",
  (stack) =>
    Effect.gen(function* () {
      yield* cleanSlate(stack);
      const first = yield* stack.deploy(
        ClickHouseCloud.Service.Service("Regional", {
          ...small,
          ipAccessList: [{ source: "0.0.0.0/0" }],
        }),
      );
      const second = yield* stack.deploy(
        ClickHouseCloud.Service.Service("Regional", {
          ...small,
          region: "us-east-2",
          ipAccessList: [{ source: "0.0.0.0/0" }],
        }),
      );
      expect(second.serviceId).not.toEqual(first.serviceId);
      expect(second.region).toEqual("us-east-2");
      // The old service is deleted first and waited on.
      expect(yield* getService(first.serviceId)).toBeUndefined();
      yield* stack.destroy();
    }).pipe(Effect.scoped),
  { tags: ["provider:clickhouse-cloud", "live"], timeout: 3_600_000 },
);

/** The text of the 409 `deleteService` answers under deletion protection (live, 2026-11-12). */
const DELETION_PROTECTED =
  "CONFLICT: Deletion protection is enabled for this service. Turn it off before deleting the service.";

test.provider.skipIf(slow)(
  "destroy refuses a protected service with ServiceDeletionProtected until protection is off",
  (stack) =>
    Effect.gen(function* () {
      yield* cleanSlate(stack);
      // Stopped, so the refused delete answers at once.
      const protectedService = (deletionProtection: boolean) =>
        ClickHouseCloud.Service.Service("Protected", {
          ...small,
          ipAccessList: [],
          deletionProtection,
          state: "stopped",
        });

      const created = yield* stack.deploy(protectedService(true));
      expect(created.deletionProtection).toBe(true);

      // The engine aggregates delete failures into a DestroyError; the
      // service's cause is the provider's typed error, wrapping the SDK's.
      const refused = yield* Effect.flip(stack.destroy());
      assert(refused instanceof DestroyError);
      expect(refused.failures.map((f) => f.logicalId)).toEqual(["Protected"]);
      const protectedError = Cause.squash(refused.failures[0]!.cause);
      assert(protectedError instanceof ClickHouseCloud.ServiceDeletionProtected);
      expect(protectedError.serviceId).toEqual(created.serviceId);
      expect(protectedError.cause).toMatchObject({
        _tag: "DeletionProtectionEnabled",
        message: DELETION_PROTECTED,
      });
      expect((yield* getService(created.serviceId))?.state).toEqual("stopped");

      // Protection turns off on the stopped service, then destroy deletes it.
      const unprotected = yield* stack.deploy(protectedService(false));
      expect(unprotected.serviceId).toEqual(created.serviceId);
      expect(unprotected.deletionProtection).toBe(false);
      yield* stack.destroy();
      // Destroy waits until the service is gone.
      expect(yield* getService(created.serviceId)).toBeUndefined();
    }).pipe(Effect.scoped),
  { tags: ["provider:clickhouse-cloud", "live"], timeout: 3_600_000 },
);

// Fills the organization's service quota (one service on the trial
// organization, whose quota is 2), so run service suites one at a time:
// services another test creates at the same time change the count.
test.provider.skipIf(slow)(
  "a service beyond the organization's quota fails with ServiceLimitReached",
  (stack) =>
    Effect.gen(function* () {
      yield* cleanSlate(stack);
      const organizationId = yield* ClickHouseCloud.organizationId;
      const { result: quota } = yield* organization.getOrganizationQuota({
        organizationId,
        quotaCode: "services-per-organization",
      });
      const room = (quota?.value ?? 0) - (quota?.usage ?? 0);
      expect(room).toBeGreaterThanOrEqual(1);

      const fillers = (count: number) =>
        Effect.forEach(
          Array.from({ length: count }, (_, i) => i),
          (i) => ClickHouseCloud.Service.Service(`Filler${i}`, { ...small, ipAccessList: [] }),
        );
      yield* stack.deploy(fillers(room));

      const refused = yield* stack
        .deploy(
          Effect.gen(function* () {
            yield* fillers(room);
            return yield* ClickHouseCloud.Service.Service("Overflow", {
              ...small,
              ipAccessList: [],
            });
          }),
        )
        .pipe(Effect.flip);
      assert(refused instanceof ClickHouseCloud.ServiceLimitReached);
      expect(refused.cause).toMatchObject({
        _tag: "InstanceLimitReached",
        message: "INSTANCE_LIMIT_REACHED",
      });

      yield* stack.destroy();
    }).pipe(Effect.scoped),
  { tags: ["provider:clickhouse-cloud", "live"], timeout: 3_600_000 },
);
