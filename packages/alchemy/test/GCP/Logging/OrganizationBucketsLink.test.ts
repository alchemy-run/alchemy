import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as logging from "@distilled.cloud/gcp/logging_v2";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
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
  logging.getOrganizationsLocationsBucketsLinks({ name }).pipe(
    Effect.map((link) =>
      link.lifecycleState === "DELETE_REQUESTED"
        ? ("gone" as const)
        : ("found" as const),
    ),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const organizationOf = () =>
  Effect.gen(function* () {
    let current: string | undefined = `projects/${project}`;
    for (let i = 0; i < 8; i++) {
      if (current === undefined) return "";
      if (current.startsWith("organizations/")) return current;
      current = current.startsWith("projects/")
        ? yield* resourcemanager.getProjects({ name: current }).pipe(
            Effect.map((resource) => resource.parent),
            Effect.catchTag(["NotFound", "Forbidden"], () =>
              Effect.succeed(undefined),
            ),
          )
        : current.startsWith("folders/")
          ? yield* resourcemanager.getFolders({ name: current }).pipe(
              Effect.map((folder) => folder.parent),
              Effect.catchTag(["NotFound", "Forbidden"], () =>
                Effect.succeed(undefined),
              ),
            )
          : undefined;
    }
    return "";
  });

test.provider.skipIf(!hasGcpCreds)(
  "getOrganizationsLocationsBucketsLinks on a missing link fails with NotFound or Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const organization = (yield* organizationOf()) || "organizations/0";
      const error = yield* Effect.flip(
        logging.getOrganizationsLocationsBucketsLinks({
          name: `${organization}/locations/global/buckets/_Default/links/alchemy_missing`,
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "create, replace, and delete an organization logging bucket link",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const organization = yield* organizationOf();
      if (organization.length === 0) {
        const error = yield* Effect.flip(
          logging.createOrganizationsLocationsBucketsLinks({
            parent: "organizations/0/locations/global/buckets/_Default",
            linkId: "alchemy_probe",
            body: { description: "probe" },
          }),
        );
        expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);
        yield* stack.destroy();
        return;
      }

      const access = yield* logging
        .listOrganizationsLocationsBuckets({
          parent: `${organization}/locations/-`,
          pageSize: 1,
        })
        .pipe(
          Effect.as("ok" as const),
          Effect.catchTag(["Forbidden", "NotFound"], (error) =>
            Effect.succeed(error._tag),
          ),
        );
      if (access !== "ok") {
        expect(["Forbidden", "NotFound"]).toContain(access);
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* GCP.Logging.OrganizationLogBucket("Analytics", {
            organization,
            analyticsEnabled: true,
            description: "analytics parent",
          });
          const link = yield* GCP.Logging.OrganizationBucketsLink("Bq", {
            organization,
            bucket: bucket.name,
            description: "log analytics dataset",
          });
          return { bucket, link };
        }),
      );

      expect(created.link.linkId).toEqual(expect.any(String));
      expect(created.link.bucket).toEqual(created.bucket.name);
      expect(created.link.name).toEqual(
        `${created.bucket.name}/links/${created.link.linkId}`,
      );
      expect(created.link.description).toEqual("log analytics dataset");

      const fetched = yield* logging.getOrganizationsLocationsBucketsLinks({
        name: created.link.name,
      });
      expect(fetched.description).toContain("alchemy-id=");

      const last = created.link.linkId.at(-1) ?? "a";
      const nextLinkId = `${created.link.linkId.slice(0, -1)}${last === "z" ? "0" : "a"}`;

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* GCP.Logging.OrganizationLogBucket("Analytics", {
            organization,
            bucketId: created.bucket.bucketId,
            location: created.bucket.location,
            analyticsEnabled: true,
            description: "analytics parent",
          });
          const link = yield* GCP.Logging.OrganizationBucketsLink("Bq", {
            organization,
            bucket: bucket.name,
            linkId: nextLinkId,
            description: "replaced link",
          });
          return { bucket, link };
        }),
      );

      expect(replaced.link.linkId).not.toEqual(created.link.linkId);

      const previousGone = yield* waitUntilGone(created.link.name);
      expect(previousGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.link.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
