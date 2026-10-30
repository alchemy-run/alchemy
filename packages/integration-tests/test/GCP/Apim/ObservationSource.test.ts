import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as apim from "@distilled.cloud/gcp/apim_v1alpha";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { DEFAULT_NETWORK } from "../networkQuota.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// The testing project doesn't enable apim.googleapis.com by default: every test
// deploys it first.
const ApimApi = GCP.ServiceUsage.ProjectService("ApimApi", {
  service: "apim.googleapis.com",
});
const location = "us-central1";

const waitUntilGone = (name: string) =>
  apim.getProjectsLocationsObservationSources({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsObservationSources on a missing source fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const parent = `projects/${project}/locations/${location}`;

      yield* stack.destroy();
      yield* stack.deploy(ApimApi);

      const error = yield* Effect.flip(
        apim.getProjectsLocationsObservationSources({
          name: `${parent}/observationSources/alchemy-missing-src`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apim", "live"], timeout: 90_000 },
);

test.provider(
  "create and delete an API Observation source",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const parent = `projects/${project}/locations/${location}`;

      yield* stack.destroy();
      yield* stack.deploy(ApimApi);

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          yield* ApimApi;
          const subnet = yield* GCP.Compute.Subnetwork("ApimSrcSubnet", {
            network: DEFAULT_NETWORK,
            region: location,
            ipCidrRange: "172.20.12.0/24",
            privateIpGoogleAccess: true,
          });
          const source = yield* GCP.Apim.ObservationSource("Edge", {
            location,
            gclbObservationSource: {
              pscNetworkConfigs: [
                {
                  network: DEFAULT_NETWORK,
                  subnetwork: subnet.subnetworkName,
                },
              ],
            },
          });
          return { subnet, source };
        }),
      );

      expect(created.source.name).toContain("/observationSources/");
      expect(created.source.observationSourceId).toEqual(expect.any(String));
      expect(created.source.location).toEqual(location);
      expect(created.source.gclbObservationSource?.pscNetworkConfigs.length).toBeGreaterThan(0);

      const fetched = yield* apim.getProjectsLocationsObservationSources({
        name: created.source.name,
      });
      expect(fetched.name).toEqual(created.source.name);

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.source.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apim", "live"], timeout: 120_000 },
);
