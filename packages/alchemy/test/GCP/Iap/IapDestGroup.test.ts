import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as iap from "@distilled.cloud/gcp/iap_v1";
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

const project = process.env.GOOGLE_PROJECT_ID ?? "";

const waitUntilGone = (name: string) =>
  iap.getProjectsIap_tunnelLocationsDestGroups({ name }).pipe(
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
  "getProjectsIap_tunnelLocationsDestGroups on a missing group fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        iap.getProjectsIap_tunnelLocationsDestGroups({
          name: `projects/${project}/iap_tunnel/locations/us-central1/destGroups/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create, update, and delete an IAP tunnel dest group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const access = yield* iap
        .listProjectsIap_tunnelLocationsDestGroups({
          parent: `projects/${project}/iap_tunnel/locations/-`,
          pageSize: 1,
        })
        .pipe(
          Effect.as("ok" as const),
          Effect.catchTag("Forbidden", (error) => Effect.succeed(error)),
          Effect.catchTag("NotFound", (error) => Effect.succeed(error)),
        );
      if (access !== "ok") {
        expect(["Forbidden", "NotFound"]).toContain(access._tag);
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Iap.IapDestGroup("SshHosts", {
            location: "us-central1",
            cidrs: ["10.241.0.0/24"],
          });
        }),
      );

      expect(created.name).toContain("/destGroups/");
      expect(created.destGroupId.length).toBeGreaterThanOrEqual(4);
      expect(created.location).toEqual("us-central1");
      expect(created.project).toEqual(project);
      expect(created.cidrs).toEqual(["10.241.0.0/24"]);
      expect(created.fqdns).toEqual([]);

      const fetched = yield* iap.getProjectsIap_tunnelLocationsDestGroups({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.cidrs).toContain("10.241.0.0/24");
      expect(
        fetched.fqdns?.some((fqdn) => fqdn.endsWith(".alc.invalid")),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Iap.IapDestGroup("SshHosts", {
            destGroupId: created.destGroupId,
            location: "us-central1",
            cidrs: ["10.241.0.0/24", "10.241.1.0/24"],
            fqdns: ["db.internal.example.com"],
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.cidrs.sort()).toEqual(
        ["10.241.0.0/24", "10.241.1.0/24"].sort(),
      );
      expect(updated.fqdns).toEqual(["db.internal.example.com"]);

      const fetchedUpdate = yield* iap.getProjectsIap_tunnelLocationsDestGroups(
        {
          name: created.name,
        },
      );
      expect(fetchedUpdate.cidrs?.sort()).toEqual(
        ["10.241.0.0/24", "10.241.1.0/24"].sort(),
      );
      expect(fetchedUpdate.fqdns).toContain("db.internal.example.com");
      expect(
        fetchedUpdate.fqdns?.some((fqdn) => fqdn.endsWith(".alc.invalid")),
      ).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
