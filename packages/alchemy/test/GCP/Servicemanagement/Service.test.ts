import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as servicemanagement from "@distilled.cloud/gcp/servicemanagement_v1";
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

const project = process.env.GOOGLE_PROJECT_ID ?? "alchemy-gcp-testing-83661";
const missingName = `alch-missing.endpoints.${project}.cloud.goog`;
const lifecycleName = `alch-sm-lifecycle.endpoints.${project}.cloud.goog`;

const waitUntilGone = (serviceName: string) =>
  servicemanagement.getServices({ serviceName }).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["NotFound", "ServiceNotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.catchTag("Forbidden", (error) =>
      error.message.toLowerCase().includes("not found")
        ? Effect.succeed("gone" as const)
        : Effect.fail(error),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getServices on a missing service fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        servicemanagement.getServices({ serviceName: missingName }),
      );
      expect([
        "NotFound",
        "ServiceNotFound",
        "Forbidden",
        "ServiceManagementApiDisabled",
      ]).toContain(error._tag);
      if (error._tag === "Forbidden") {
        expect(error.message.toLowerCase()).toContain("not found");
      }
      console.log("servicemanagement getServices missing", error._tag);

      const page = yield* servicemanagement
        .listServices({
          producerProjectId: project,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag(
            ["Forbidden", "NotFound", "ServiceManagementApiDisabled"],
            () => Effect.succeed({ services: [] as const }),
          ),
        );
      expect(Array.isArray(page.services ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "create, update, and delete a managed service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const access = yield* servicemanagement
        .getServices({ serviceName: missingName })
        .pipe(
          Effect.as("ok" as const),
          Effect.catchTag(["NotFound", "ServiceNotFound"], () =>
            Effect.succeed("ok" as const),
          ),
          Effect.catchTag("ServiceManagementApiDisabled", (error) => {
            console.log(
              `servicemanagement get skip tag=${error._tag} message=${error.message}`,
            );
            return Effect.succeed(error);
          }),
          Effect.catchTag("Forbidden", (error) => {
            const apiDisabled = error.message
              .toLowerCase()
              .includes("has not been used");
            if (apiDisabled) {
              console.log(
                `servicemanagement get skip tag=${error._tag} message=${error.message}`,
              );
            }
            return Effect.succeed(apiDisabled ? error : ("ok" as const));
          }),
        );
      if (access !== "ok") {
        expect(["ServiceManagementApiDisabled", "Forbidden"]).toContain(
          access._tag,
        );
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Servicemanagement.Service("Hello", {
            serviceName: lifecycleName,
            title: "Alchemy SM",
          });
        }),
      );

      expect(created.serviceName).toEqual(lifecycleName);
      expect(created.producerProjectId).toEqual(project);
      expect(created.title).toEqual("Alchemy SM");

      const fetched = yield* servicemanagement.getServices({
        serviceName: created.serviceName,
      });
      expect(fetched.serviceName).toEqual(created.serviceName);
      expect(fetched.producerProjectId).toEqual(project);

      const config = yield* servicemanagement
        .listServicesConfigs({
          serviceName: created.serviceName,
          pageSize: 20,
        })
        .pipe(
          Effect.map(
            (page) => page.serviceConfigs?.[0] ?? { title: undefined },
          ),
        );
      expect(config.title ?? config.documentation?.summary ?? "").toContain(
        "[alchemy ",
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Servicemanagement.Service("Hello", {
            serviceName: created.serviceName,
            title: "Alchemy SM v2",
          });
        }),
      );

      expect(updated.serviceName).toEqual(created.serviceName);
      expect(updated.title).toEqual("Alchemy SM v2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.serviceName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 180_000 },
);
