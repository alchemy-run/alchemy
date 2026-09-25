import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as androidmanagement from "@distilled.cloud/gcp/androidmanagement_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  enterpriseName,
  hasGcpCreds,
  logLevel,
  runLifecycle,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  androidmanagement.getEnterprisesEnrollmentTokens({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getEnterprisesEnrollmentTokens on a missing token fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        androidmanagement.getEnterprisesEnrollmentTokens({
          name: "enterprises/alchemy-missing-enterprise/enrollmentTokens/alchemy-missing",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_ANDROIDMANAGEMENT)(
  "createEnterprisesEnrollmentTokens without Android Management access fails with a typed entitlement error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        androidmanagement.createEnterprisesEnrollmentTokens({
          parent: "enterprises/alchemy-missing-enterprise",
          body: {
            duration: "3600s",
            additionalData: "alchemy-probe",
          },
        }),
      );
      expect(["Forbidden", "BadRequest", "NotFound"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an enrollment token",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const enterprise = enterpriseName
            ? { name: enterpriseName }
            : yield* GCP.Androidmanagement.Enterprise("TokenHost", {
                enterpriseDisplayName: "Token Host",
              });
          const token = yield* GCP.Androidmanagement.EnterprisesEnrollmentToken(
            "Enroll",
            {
              parent: enterprise.name,
              duration: "86400s",
              additionalData: "org-unit-a",
            },
          );
          return { enterprise, token };
        }),
      );

      expect(created.token.name).toContain("/enrollmentTokens/");
      expect(created.token.parent).toEqual(created.enterprise.name);
      expect(created.token.enrollmentTokenId.length).toBeGreaterThan(0);
      expect(created.token.value).toEqual(expect.any(String));

      const fetched = yield* androidmanagement.getEnterprisesEnrollmentTokens({
        name: created.token.name,
      });
      expect(fetched.name).toEqual(created.token.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const enterprise = enterpriseName
            ? { name: enterpriseName }
            : yield* GCP.Androidmanagement.Enterprise("TokenHost", {
                enterpriseDisplayName: "Token Host",
              });
          return yield* GCP.Androidmanagement.EnterprisesEnrollmentToken(
            "Enroll",
            {
              parent: enterprise.name,
              duration: "172800s",
              additionalData: "org-unit-b",
            },
          );
        }),
      );

      expect(updated.name).not.toEqual(created.token.name);
      expect(updated.parent).toEqual(created.enterprise.name);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(updated.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
