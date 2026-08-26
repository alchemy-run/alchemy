import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as apigee from "@distilled.cloud/gcp/apigee_v1";
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
  hasGcpCreds && !!process.env.GCP_TEST_APIGEE && !process.env.FAST;

const project = process.env.GOOGLE_PROJECT_ID ?? "";

const waitUntilGone = (name: string) =>
  apigee.getOrganizationsSharedflows({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["NotFound", "Forbidden"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const descriptionFromBundle = (body: apigee.GoogleApiHttpBody) =>
  Effect.gen(function* () {
    const data = body.data;
    if (data === undefined || data.length === 0) return "";
    const JSZip = (yield* Effect.promise(() => import("jszip"))).default;
    const bytes = yield* Effect.sync(() => Buffer.from(data, "base64"));
    const zip = yield* Effect.promise(() => JSZip.loadAsync(bytes));
    const xmlPath = Object.keys(zip.files).find(
      (path) =>
        /^sharedflowbundle\/[^/]+\.xml$/i.test(path) &&
        zip.files[path]?.dir !== true,
    );
    if (xmlPath === undefined) return "";
    const file = zip.file(xmlPath);
    if (!file) return "";
    return yield* Effect.promise(() => file.async("string"));
  });

test.provider.skipIf(!hasGcpCreds)(
  "getOrganizationsSharedflows on a missing shared flow fails with NotFound or Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        apigee.getOrganizationsSharedflows({
          name: `organizations/${project}/sharedflows/alchemy-apigee-missing-flow`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an Apigee shared flow",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Apigee.Sharedflow("Traffic", {
            description: "alchemy test shared flow",
          });
        }),
      );

      expect(created.sharedflowId).toEqual(expect.any(String));
      expect(created.organization).toEqual(project);
      expect(created.name).toEqual(
        `organizations/${project}/sharedflows/${created.sharedflowId}`,
      );
      expect(created.description).toEqual("alchemy test shared flow");
      expect(created.latestRevisionId).toEqual(expect.any(String));

      const fetched = yield* apigee.getOrganizationsSharedflows({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.sharedflowId);

      const revision = yield* apigee.getOrganizationsSharedflowsRevisions({
        name: `${created.name}/revisions/${created.latestRevisionId}`,
        format: "bundle",
      });
      const createdXml = yield* descriptionFromBundle(revision);
      expect(createdXml).toContain("alchemy-id=");
      expect(createdXml).toContain("alchemy test shared flow");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Apigee.Sharedflow("Traffic", {
            sharedflowId: created.sharedflowId,
            description: "alchemy updated shared flow",
          });
        }),
      );

      expect(updated.sharedflowId).toEqual(created.sharedflowId);
      expect(updated.description).toEqual("alchemy updated shared flow");
      expect(updated.latestRevisionId).not.toEqual(created.latestRevisionId);

      const fetchedRevision =
        yield* apigee.getOrganizationsSharedflowsRevisions({
          name: `${updated.name}/revisions/${updated.latestRevisionId}`,
          format: "bundle",
        });
      const updatedXml = yield* descriptionFromBundle(fetchedRevision);
      expect(updatedXml).toContain("alchemy updated shared flow");
      expect(updatedXml).toContain("alchemy-id=");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
