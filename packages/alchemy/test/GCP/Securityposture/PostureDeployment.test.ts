import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as securityposture from "@distilled.cloud/gcp/securityposture_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  hasGcpCreds,
  logLevel,
  organizationOf,
  waitUntilDeploymentGone,
  waitUntilPostureGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!hasGcpCreds)(
  "getOrganizationsLocationsPostureDeployments on a missing deployment fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const organization = (yield* organizationOf()) || "organizations/0";
      const error = yield* Effect.flip(
        securityposture.getOrganizationsLocationsPostureDeployments({
          name: `${organization}/locations/global/postureDeployments/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "create, update, and delete a posture deployment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const organization = yield* organizationOf();
      if (organization.length === 0) {
        const error = yield* Effect.flip(
          securityposture.createOrganizationsLocationsPostureDeployments({
            parent: "organizations/0/locations/global",
            postureDeploymentId: "alchemy-probe",
            body: {
              targetResource: "projects/0",
              postureId:
                "organizations/0/locations/global/postures/alchemy-missing",
              postureRevisionId: "00000000",
            },
          }),
        );
        expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);
        yield* stack.destroy();
        return;
      }

      const access = yield* securityposture
        .listOrganizationsLocationsPostureDeployments({
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
          "Permission 'securityposture.postureDeployments.list' denied",
        );
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const posture = yield* GCP.Securityposture.Posture("Baseline", {
            organization,
            state: "ACTIVE",
            description: "deployable baseline",
            annotations: { env: "test" },
          });
          const deployment = yield* GCP.Securityposture.PostureDeployment(
            "Staging",
            {
              organization,
              postureId: posture.name,
              postureRevisionId: posture.revisionId.as<string>(),
              description: "staging deployment",
              annotations: { env: "test" },
            },
          );
          return { posture, deployment };
        }),
      );

      expect(created.posture.state).toEqual("ACTIVE");
      expect(created.posture.revisionId).toEqual(expect.any(String));
      expect(created.deployment.postureDeploymentId).toEqual(
        expect.any(String),
      );
      expect(created.deployment.organization).toEqual(organization);
      expect(created.deployment.name).toEqual(
        `${organization}/locations/global/postureDeployments/${created.deployment.postureDeploymentId}`,
      );
      expect(created.deployment.postureId).toEqual(created.posture.name);
      expect(created.deployment.postureRevisionId).toEqual(
        created.posture.revisionId,
      );
      expect(created.deployment.description).toEqual("staging deployment");
      expect(created.deployment.annotations).toMatchObject({ env: "test" });

      const fetched =
        yield* securityposture.getOrganizationsLocationsPostureDeployments({
          name: created.deployment.name,
        });
      expect(fetched.name).toEqual(created.deployment.name);
      expect(fetched.annotations?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const posture = yield* GCP.Securityposture.Posture("Baseline", {
            organization,
            postureId: created.posture.postureId,
            state: "ACTIVE",
            description: "deployable baseline v2",
            annotations: { env: "prod" },
          });
          const deployment = yield* GCP.Securityposture.PostureDeployment(
            "Staging",
            {
              organization,
              postureDeploymentId: created.deployment.postureDeploymentId,
              postureId: posture.name,
              postureRevisionId: posture.revisionId.as<string>(),
              description: "staging deployment v2",
              annotations: { env: "prod" },
            },
          );
          return { posture, deployment };
        }),
      );

      expect(updated.deployment.name).toEqual(created.deployment.name);
      expect(updated.deployment.postureId).toEqual(updated.posture.name);
      expect(updated.posture.description).toEqual("deployable baseline v2");

      yield* stack.destroy();

      const deploymentGone = yield* waitUntilDeploymentGone(
        created.deployment.name,
      );
      expect(deploymentGone).toEqual("gone");
      const postureGone = yield* waitUntilPostureGone(created.posture.name);
      expect(postureGone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
