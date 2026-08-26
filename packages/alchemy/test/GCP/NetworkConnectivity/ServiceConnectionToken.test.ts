import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as networkconnectivity from "@distilled.cloud/gcp/networkconnectivity_v1";
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

const runLifecycle = hasGcpCreds && !process.env.FAST;
const project = process.env.GOOGLE_PROJECT_ID ?? "";

const waitUntilGone = (name: string) =>
  networkconnectivity
    .getProjectsLocationsServiceConnectionTokens({ name })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsServiceConnectionTokens on a missing token fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        networkconnectivity.getProjectsLocationsServiceConnectionTokens({
          name: `projects/${project}/locations/us-central1/serviceConnectionTokens/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create and delete a service connection token",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const network = yield* GCP.Compute.Network("SctVpc", {
            autoCreateSubnetworks: false,
          });
          const token = yield* GCP.NetworkConnectivity.ServiceConnectionToken(
            "Consumer",
            {
              network: network.selfLink.as<string>(),
              description: "token a",
              labels: { env: "test" },
            },
          );
          return { network, token };
        }),
      );

      expect(created.token.name).toContain("/serviceConnectionTokens/");
      expect(created.token.location).toEqual("us-central1");
      expect(created.token.description).toEqual("token a");
      expect(created.token.labels).toMatchObject({ env: "test" });
      expect(created.token.serviceConnectionTokenId).toEqual(
        expect.any(String),
      );

      const fetched =
        yield* networkconnectivity.getProjectsLocationsServiceConnectionTokens({
          name: created.token.name,
        });
      expect(fetched.name).toEqual(created.token.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.token.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 180_000 },
);
