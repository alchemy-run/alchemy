import * as iam from "@distilled.cloud/gcp/unstable/iam_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// Deleted pools and providers are soft-deleted (state DELETED) for 30 days.
const waitUntilDeleted = (get: Effect.Effect<{ state?: string }, { _tag: string }>) =>
  get.pipe(
    Effect.map((resource) => (resource.state === "DELETED" ? "gone" : "found")),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";

test.provider(
  "create, update, and delete a workload identity pool and provider",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const deploy = (options: { displayName: string; condition: string; disabled?: boolean }) =>
        stack.deploy(
          Effect.gen(function* () {
            const pool = yield* GCP.IAM.WorkloadIdentityPool("Ci", {
              displayName: options.displayName,
              description: "test pool",
              disabled: options.disabled,
            });
            const provider = yield* GCP.IAM.WorkloadIdentityProvider("Github", {
              workloadIdentityPoolId: pool.workloadIdentityPoolId,
              displayName: "GitHub OIDC",
              attributeMapping: {
                "google.subject": "assertion.sub",
                "attribute.repository": "assertion.repository",
              },
              attributeCondition: options.condition,
              oidc: { issuerUri: GITHUB_ISSUER },
            });
            return { pool, provider };
          }),
        );

      const created = yield* deploy({
        displayName: "Alchemy CI",
        condition: `assertion.repository == "alchemy-run/alchemy"`,
      });

      expect(created.pool.workloadIdentityPoolId).toMatch(/^[a-z][a-z0-9-]{2,30}[a-z0-9]$/);
      expect(created.pool.name).toEqual(
        `projects/${project}/locations/global/workloadIdentityPools/${created.pool.workloadIdentityPoolId}`,
      );
      expect(created.pool.displayName).toEqual("Alchemy CI");
      expect(created.pool.description).toEqual("test pool");
      expect(created.pool.disabled).toEqual(false);
      expect(created.provider.workloadIdentityPoolId).toEqual(created.pool.workloadIdentityPoolId);
      expect(created.provider.oidc?.issuerUri).toEqual(GITHUB_ISSUER);
      expect(created.provider.attributeMapping).toEqual({
        "google.subject": "assertion.sub",
        "attribute.repository": "assertion.repository",
      });

      const fetchedPool = yield* iam.getProjectsLocationsWorkloadIdentityPools({
        name: created.pool.name,
      });
      expect(fetchedPool.state).toEqual("ACTIVE");
      expect(fetchedPool.description).toMatch(/^\[alchemy .*alchemy-id=\S*ci\]\ntest pool$/);
      const fetchedProvider = yield* iam.getProjectsLocationsWorkloadIdentityPoolsProviders({
        name: created.provider.name,
      });
      expect(fetchedProvider.attributeCondition).toEqual(
        `assertion.repository == "alchemy-run/alchemy"`,
      );

      // Updates happen in place.
      const updated = yield* deploy({
        displayName: "Alchemy CI (prod)",
        condition: `assertion.repository == "alchemy-run/alchemy" && assertion.ref == "refs/heads/main"`,
        disabled: true,
      });
      expect(updated.pool.name).toEqual(created.pool.name);
      expect(updated.pool.displayName).toEqual("Alchemy CI (prod)");
      expect(updated.pool.disabled).toEqual(true);
      expect(updated.provider.name).toEqual(created.provider.name);
      expect(updated.provider.attributeCondition).toMatch(/refs\/heads\/main/);

      const refetchedProvider = yield* iam.getProjectsLocationsWorkloadIdentityPoolsProviders({
        name: created.provider.name,
      });
      expect(refetchedProvider.attributeCondition).toMatch(/refs\/heads\/main/);
      const refetchedPool = yield* iam.getProjectsLocationsWorkloadIdentityPools({
        name: created.pool.name,
      });
      expect(refetchedPool.disabled).toEqual(true);

      yield* stack.destroy();

      expect(
        yield* waitUntilDeleted(
          iam.getProjectsLocationsWorkloadIdentityPoolsProviders({ name: created.provider.name }),
        ),
      ).toEqual("gone");
      expect(
        yield* waitUntilDeleted(
          iam.getProjectsLocationsWorkloadIdentityPools({ name: created.pool.name }),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:iam", "live"], timeout: 180_000 },
);
