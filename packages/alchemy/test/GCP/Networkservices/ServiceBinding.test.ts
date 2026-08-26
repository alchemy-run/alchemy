import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as networkservices from "@distilled.cloud/gcp/networkservices_v1";
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

const waitUntilGone = (name: string) =>
  networkservices.getProjectsLocationsServiceBindings({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsServiceBindings on a missing binding fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const project = process.env.GOOGLE_PROJECT_ID ?? "";
      const error = yield* Effect.flip(
        networkservices.getProjectsLocationsServiceBindings({
          name: `projects/${project}/locations/global/serviceBindings/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create, update, and delete a service binding",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Networkservices.ServiceBinding("Binding", {
            location: "global",
            description: "binding a",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/serviceBindings/");
      expect(created.serviceBindingId).toEqual(expect.any(String));
      expect(created.location).toEqual("global");
      expect(created.description).toEqual("binding a");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.createTime).toEqual(expect.any(String));

      const fetched =
        yield* networkservices.getProjectsLocationsServiceBindings({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toEqual("binding a");
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Networkservices.ServiceBinding("Binding", {
            serviceBindingId: created.serviceBindingId,
            location: "global",
            description: "binding b",
            labels: { env: "prod", role: "bind" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("binding b");
      expect(updated.labels).toMatchObject({
        env: "prod",
        role: "bind",
      });

      const refetched =
        yield* networkservices.getProjectsLocationsServiceBindings({
          name: created.name,
        });
      expect(refetched.description).toEqual("binding b");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("bind");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
