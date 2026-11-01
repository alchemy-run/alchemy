import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as objectStorage from "@distilled.cloud/stackit/object_storage";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";

const { test } = makeStackitTest();

/** Out-of-band: the project's lock, or `undefined` when there is none. */
const observeLock = (projectId: string, region: string) =>
  objectStorage.getComplianceLock({ projectId, region }).pipe(
    Effect.map((lock) => lock.maxRetentionDays),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

const waitUntilLockGone = (projectId: string, region: string) =>
  observeLock(projectId, region).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (lock) => lock === undefined,
      times: 10,
    }),
  );

test.provider(
  "create, redeploy unchanged, and delete the compliance lock",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const lock = yield* stack.deploy(Stackit.ObjectStorage.ComplianceLock("Lock", {}));
      expect(lock.projectId).toEqual(projectId);
      expect(lock.region).toEqual(region);
      expect(lock.maxRetentionDays).toBeGreaterThan(0);
      expect(yield* observeLock(projectId, region)).toEqual(lock.maxRetentionDays);

      const plan = yield* stack.plan(Stackit.ObjectStorage.ComplianceLock("Lock", {}));
      expect(plan.resources.Lock).toMatchObject({ action: "noop" });

      yield* stack.destroy();

      expect(yield* waitUntilLockGone(projectId, region)).toBeUndefined();
    }).pipe(logLevel),
  {
    tags: stackitTags("objectstorage", "compliancelock"),
    timeout: 120_000,
    // One lock per project: serialize with the Object Lock bucket case.
    exclusive: "stackit:objectstorage-compliance-lock",
  },
);
