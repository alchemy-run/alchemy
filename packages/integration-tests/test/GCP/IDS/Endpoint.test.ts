import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as ids from "@distilled.cloud/gcp/ids_v1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { withNetworkSlot } from "../networkQuota.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const location = "us-central1-a";

const IdsApi = GCP.ServiceUsage.ProjectService("IdsApi", { service: "ids.googleapis.com" });

const endpoint = (props: { trafficLogs: boolean; labels: Record<string, string> }) =>
  Effect.gen(function* () {
    yield* IdsApi;
    const vpc = yield* GCP.Compute.Network("Vpc", { autoCreateSubnetworks: false });
    const range = yield* GCP.Compute.GlobalAddress("PsaRange", {
      addressType: "INTERNAL",
      purpose: "VPC_PEERING",
      network: vpc.selfLink,
      prefixLength: 24,
    });
    const psa = yield* GCP.ServiceNetworking.Connection("Psa", {
      network: vpc.networkName,
      service: "servicenetworking.googleapis.com",
      reservedPeeringRanges: [range.addressName],
    });
    return yield* GCP.IDS.Endpoint("Ids", {
      location,
      network: psa.network,
      severity: "MEDIUM",
      ...props,
    });
  });

const waitUntilGone = (name: string) =>
  ids.getProjectsLocationsEndpoints({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );

test.provider(
  "getProjectsLocationsEndpoints on a missing endpoint fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();
      yield* stack.deploy(IdsApi);

      const error = yield* Effect.flip(
        ids.getProjectsLocationsEndpoints({
          name: `projects/${project}/locations/${location}/endpoints/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:ids", "live"], timeout: 90_000 },
);

// An IDS endpoint takes 15–20 minutes to provision, so `--fast` skips the lifecycle.
test.provider.skipIf(!!process.env.FAST)(
  "create, update, and delete an IDS endpoint",
  (stack) =>
    withNetworkSlot(
      Effect.gen(function* () {
        yield* stack.destroy();

        const created = yield* stack.deploy(
          endpoint({ trafficLogs: false, labels: { env: "test" } }),
        );
        expect(created.name).toContain(`/locations/${location}/endpoints/`);
        expect(created.state).toEqual("READY");
        expect(created.endpointForwardingRule).toEqual(expect.any(String));

        const unchanged = yield* stack.plan(
          endpoint({ trafficLogs: false, labels: { env: "test" } }),
        );
        expect(unchanged.resources.Ids?.action).toEqual("noop");

        // Traffic logs and labels update in place.
        const updated = yield* stack.deploy(
          endpoint({ trafficLogs: true, labels: { env: "prod" } }),
        );
        expect(updated.name).toEqual(created.name);
        const fetched = yield* ids.getProjectsLocationsEndpoints({ name: created.name });
        expect(fetched.trafficLogs).toEqual(true);
        expect(fetched.labels?.env).toEqual("prod");

        yield* stack.destroy();
        expect(yield* waitUntilGone(created.name)).toEqual("gone");
      }),
    ).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:ids", "live"], timeout: 3_600_000 },
);
