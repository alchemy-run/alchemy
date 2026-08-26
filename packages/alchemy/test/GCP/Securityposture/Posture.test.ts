import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as securityposture from "@distilled.cloud/gcp/securityposture_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  hasGcpCreds,
  logLevel,
  organizationOf,
  updatedPolicySets,
  waitUntilPostureGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!hasGcpCreds)(
  "getOrganizationsLocationsPostures on a missing posture fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const organization = (yield* organizationOf()) || "organizations/0";
      const error = yield* Effect.flip(
        securityposture.getOrganizationsLocationsPostures({
          name: `${organization}/locations/global/postures/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create, update, and delete a posture",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const organization = yield* organizationOf();
      if (organization.length === 0) {
        const error = yield* Effect.flip(
          securityposture.createOrganizationsLocationsPostures({
            parent: "organizations/0/locations/global",
            postureId: "alchemy-probe",
            body: {
              state: "DRAFT",
              policySets: updatedPolicySets,
            },
          }),
        );
        expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);
        yield* stack.destroy();
        return;
      }

      const access = yield* securityposture
        .listOrganizationsLocationsPostures({
          parent: `${organization}/locations/global`,
          pageSize: 1,
        })
        .pipe(
          Effect.as("ok" as const),
          Effect.catchTag("Forbidden", (error) => Effect.succeed(error)),
        );
      if (access !== "ok") {
        expect(access._tag).toEqual("Forbidden");
        expect(access.message).toContain(
          "Permission 'securityposture.postures.list' denied",
        );
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Securityposture.Posture("Baseline", {
            organization,
            description: "staging baseline",
            annotations: { env: "test" },
          });
        }),
      );

      expect(created.postureId).toEqual(expect.any(String));
      expect(created.organization).toEqual(organization);
      expect(created.location).toEqual("global");
      expect(created.name).toEqual(
        `${organization}/locations/global/postures/${created.postureId}`,
      );
      expect(created.state).toEqual("DRAFT");
      expect(created.description).toEqual("staging baseline");
      expect(created.annotations).toMatchObject({ env: "test" });
      expect(created.policySets.length).toBeGreaterThan(0);
      expect(created.revisionId).toEqual(expect.any(String));

      const fetched = yield* securityposture.getOrganizationsLocationsPostures({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.annotations?.env).toEqual("test");
      expect(fetched.annotations?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Securityposture.Posture("Baseline", {
            organization,
            postureId: created.postureId,
            description: "updated baseline",
            annotations: { env: "prod" },
            policySets: updatedPolicySets,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("updated baseline");
      expect(updated.policySets.map((set) => set.policySetId)).toContain(
        "alchemy",
      );
      expect(
        updated.policySets[0]?.policies?.map((policy) => policy.policyId),
      ).toEqual(["alchemy-sha", "alchemy-sha-2"]);

      yield* stack.destroy();

      const gone = yield* waitUntilPostureGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
