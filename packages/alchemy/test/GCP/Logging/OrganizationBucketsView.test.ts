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
  logging.getOrganizationsLocationsBucketsViews({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
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
  "getOrganizationsLocationsBucketsViews on a missing view fails with NotFound or Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const organization = (yield* organizationOf()) || "organizations/0";
      const error = yield* Effect.flip(
        logging.getOrganizationsLocationsBucketsViews({
          name: `${organization}/locations/global/buckets/_Default/views/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create, update, replace, and delete an organization logging bucket view",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const organization = yield* organizationOf();
      if (organization.length === 0) {
        const error = yield* Effect.flip(
          logging.createOrganizationsLocationsBucketsViews({
            parent: "organizations/0/locations/global/buckets/_Default",
            viewId: "alchemy-probe",
            body: { filter: 'LOG_ID("stdout")' },
          }),
        );
        expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);
        yield* stack.destroy();
        return;
      }

      const access = yield* logging
        .getOrganizationsLocationsBuckets({
          name: `${organization}/locations/global/buckets/_Default`,
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
          return yield* GCP.Logging.OrganizationBucketsView("Stdout", {
            organization,
            filter: 'LOG_ID("stdout")',
            description: "stdout only",
          });
        }),
      );

      expect(created.viewId).toEqual(expect.any(String));
      expect(created.organization).toEqual(organization);
      expect(created.bucketId).toEqual("_Default");
      expect(created.filter).toEqual('LOG_ID("stdout")');
      expect(created.description).toEqual("stdout only");

      const fetched = yield* logging.getOrganizationsLocationsBucketsViews({
        name: created.name,
      });
      expect(fetched.filter).toEqual('LOG_ID("stdout")');
      expect(fetched.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.OrganizationBucketsView("Stdout", {
            organization,
            viewId: created.viewId,
            bucket: created.bucket,
            filter: 'LOG_ID("stderr")',
            description: "stderr only",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.filter).toEqual('LOG_ID("stderr")');

      const last = created.viewId.at(-1) ?? "a";
      const nextViewId = `${created.viewId.slice(0, -1)}${last === "z" ? "0" : "z"}`;

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.OrganizationBucketsView("Stdout", {
            organization,
            viewId: nextViewId,
            bucket: created.bucket,
            filter: 'LOG_ID("stdout")',
            description: "replaced view",
          });
        }),
      );

      expect(replaced.viewId).not.toEqual(created.viewId);

      const previousGone = yield* waitUntilGone(created.name);
      expect(previousGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
