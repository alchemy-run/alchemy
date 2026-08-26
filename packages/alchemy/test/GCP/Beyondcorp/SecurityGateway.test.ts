import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as beyondcorp from "@distilled.cloud/gcp/beyondcorp_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { hasGcpCreds, logLevel, project, runLifecycle } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  beyondcorp.getProjectsLocationsSecurityGateways({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsSecurityGateways on a missing gateway fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        beyondcorp.getProjectsLocationsSecurityGateways({
          name: `projects/${project}/locations/global/securityGateways/alchemy-missing-sg`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      const page = yield* beyondcorp
        .listProjectsLocationsSecurityGateways({
          parent: `projects/${project}/locations/global`,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed({ securityGateways: [] as const }),
          ),
        );
      expect(Array.isArray(page.securityGateways ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_BEYONDCORP)(
  "createProjectsLocationsSecurityGateways without entitlement fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        beyondcorp.createProjectsLocationsSecurityGateways({
          parent: `projects/${project}/locations/global`,
          securityGatewayId: "alch-probe-sg",
          body: {
            displayName: "probe",
            hubs: { "us-central1": { internetGateway: {} } },
          },
        }),
      );
      expect(error._tag).toEqual("Forbidden");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a security gateway",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Beyondcorp.SecurityGateway("Pep", {
            location: "global",
            displayName: "gateway a",
            hubs: { "us-central1": { internetGateway: {} } },
          });
        }),
      );

      expect(created.name).toContain("/securityGateways/");
      expect(created.location).toEqual("global");
      expect(created.displayName).toEqual("gateway a");
      expect(Object.keys(created.hubs ?? {})).toContain("us-central1");

      const fetched = yield* beyondcorp.getProjectsLocationsSecurityGateways({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toContain("gateway a");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Beyondcorp.SecurityGateway("Pep", {
            securityGatewayId: created.securityGatewayId,
            location: "global",
            displayName: "gateway b",
            hubs: { "us-central1": { internetGateway: {} } },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("gateway b");

      const refetched = yield* beyondcorp.getProjectsLocationsSecurityGateways({
        name: created.name,
      });
      expect(refetched.displayName).toContain("gateway b");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
