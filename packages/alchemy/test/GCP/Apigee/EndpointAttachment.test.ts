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
  hasGcpCreds &&
  !!process.env.GCP_TEST_APIGEE &&
  !!process.env.GCP_TEST_APIGEE_ENDPOINT &&
  !process.env.FAST;

const project = process.env.GOOGLE_PROJECT_ID ?? "";
const org = `organizations/${project}`;
const serviceAttachment =
  process.env.GCP_TEST_APIGEE_SERVICE_ATTACHMENT ??
  `projects/${project}/regions/us-central1/serviceAttachments/alchemy-backend`;

const waitUntilGone = (name: string) =>
  apigee.getOrganizationsEndpointAttachments({ name }).pipe(
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
  "getOrganizationsEndpointAttachments on a missing attachment fails with NotFound or Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        apigee.getOrganizationsEndpointAttachments({
          name: `${org}/endpointAttachments/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create and delete an endpoint attachment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Apigee.EndpointAttachment("Backend", {
            location: "us-central1",
            serviceAttachment,
          });
        }),
      );

      expect(created.endpointAttachmentId.startsWith("alc")).toEqual(true);
      expect(created.location).toEqual("us-central1");
      expect(created.serviceAttachment).toEqual(serviceAttachment);

      const fetched = yield* apigee.getOrganizationsEndpointAttachments({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
