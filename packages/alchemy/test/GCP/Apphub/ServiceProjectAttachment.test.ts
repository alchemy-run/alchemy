import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as apphub from "@distilled.cloud/gcp/apphub_v1";
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

// App Hub is entitlement-gated. Live create/read returns Forbidden:
// "App Hub API has not been used in project alchemy-gcp-testing-83661
// before or it is disabled."
const runLifecycle =
  hasGcpCreds && !process.env.FAST && process.env.GCP_TEST_APPHUB === "1";
const project = process.env.GOOGLE_PROJECT_ID ?? "";
const location = "global";

const waitUntilGone = (name: string) =>
  apphub.getProjectsLocationsServiceProjectAttachments({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsServiceProjectAttachments on a missing attachment fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        apphub.getProjectsLocationsServiceProjectAttachments({
          name: `projects/${project}/locations/${location}/serviceProjectAttachments/alchemy-missing-spa`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create and delete an App Hub service project attachment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Apphub.ServiceProjectAttachment("Host", {
            serviceProject: `projects/${project}`,
          });
        }),
      );

      expect(created.name).toContain("/serviceProjectAttachments/");
      expect(created.serviceProjectAttachmentId).toEqual(project);
      expect(created.location).toEqual(location);
      expect(created.serviceProject).toBeDefined();

      const fetched =
        yield* apphub.getProjectsLocationsServiceProjectAttachments({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
