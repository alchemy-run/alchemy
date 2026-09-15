import { expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  describeInstance,
  errorResponse,
  instance,
  props,
  reconcile,
  response,
  withInstance,
} from "./DBInstance.provider.ts";

it.effect(
  "pending readiness exhausts the existing provisioning budget",
  () =>
    withInstance(
      () => describeInstance(instance({ DBInstanceStatus: "creating" })),
      (provider, requests) =>
        Effect.gen(function* () {
          const error = yield* reconcile(provider, props).pipe(Effect.flip);
          expect(error._tag).toBe("DBInstancePending");
          expect(requests).toHaveLength(62);
        }),
    ),
  { timeout: 5000 },
);

for (const status of [
  "incompatible-parameters",
  "incompatible-restore",
  "failed",
  "deleting",
  "inaccessible-encryption-credentials-recoverable",
  "storage-full",
]) {
  it.effect(
    `fails immediately when readiness is blocked by ${status}`,
    () =>
      withInstance(
        () => describeInstance(instance({ DBInstanceStatus: status })),
        (provider, requests) =>
          Effect.gen(function* () {
            const error = yield* reconcile(provider, props).pipe(Effect.flip);
            expect(error._tag).toBe("DBInstanceReadinessBlocked");
            expect(error.status).toBe(status);
            expect(requests).toHaveLength(2);
          }),
      ),
    { timeout: 5000 },
  );
}

it.effect(
  "does not retry an authorization error from a readiness read",
  () => {
    let reads = 0;
    return withInstance(
      () =>
        ++reads === 1
          ? describeInstance(instance())
          : errorResponse("AccessDenied", 403),
      (provider, requests) =>
        Effect.gen(function* () {
          const error = yield* reconcile(provider, props).pipe(Effect.flip);
          expect(error._tag).not.toBe("DBInstancePending");
          expect(requests).toHaveLength(2);
        }),
    );
  },
  { timeout: 5000 },
);

it.effect(
  "waits through pending observations without sending another modification",
  () => {
    let reads = 0;
    return withInstance(
      ({ action }) =>
        action === "DescribeDBInstances"
          ? describeInstance(
              instance({
                DBInstanceStatus: ++reads < 3 ? "modifying" : "available",
              }),
            )
          : response(action, ""),
      (provider, requests) =>
        Effect.gen(function* () {
          const result = yield* reconcile(provider, props);
          expect(result.status).toBe("available");
          expect(
            requests.filter(({ action }) => action === "ModifyDBInstance"),
          ).toEqual([]);
        }),
    );
  },
  { timeout: 5000 },
);
