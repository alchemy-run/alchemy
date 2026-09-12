import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as netapp from "@distilled.cloud/gcp/netapp_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

const runLifecycle =
  hasGcpCreds && !!process.env.GCP_TEST_NETAPP && !process.env.FAST;
const project = process.env.GOOGLE_PROJECT_ID ?? "";

const waitUntilGone = (name: string) =>
  netapp.getProjectsLocationsActiveDirectories({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsActiveDirectories on a missing directory fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        netapp.getProjectsLocationsActiveDirectories({
          name: `projects/${project}/locations/us-central1/activeDirectories/alchemy-netapp-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      const page = yield* netapp
        .listProjectsLocationsActiveDirectories({
          parent: `projects/${project}/locations/-`,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed({ activeDirectories: [] as const }),
          ),
        );
      expect(Array.isArray(page.activeDirectories ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an active directory",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Netapp.ActiveDirectory("Corp", {
            domain: "ad.example.com",
            dns: "10.0.0.2",
            netBiosPrefix: "netapp",
            username: "admin",
            password: "NotARealPassword1",
            description: "alchemy-test-ad",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/activeDirectories/");
      expect(created.domain).toEqual("ad.example.com");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* netapp.getProjectsLocationsActiveDirectories({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.domain).toEqual("ad.example.com");
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Netapp.ActiveDirectory("Corp", {
            activeDirectoryId: created.activeDirectoryId,
            domain: "ad.example.com",
            dns: "10.0.0.2",
            netBiosPrefix: "netapp",
            username: "admin",
            description: "alchemy-prod-ad",
            labels: { env: "prod", role: "ad" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("alchemy-prod-ad");
      expect(updated.labels).toMatchObject({ env: "prod", role: "ad" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
