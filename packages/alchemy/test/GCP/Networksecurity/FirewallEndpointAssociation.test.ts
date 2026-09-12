import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as networksecurity from "@distilled.cloud/gcp/networksecurity_v1";
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
  hasGcpCreds && !process.env.FAST && !!process.env.GCP_TEST_NGFW;

const waitUntilGone = (name: string) =>
  networksecurity
    .getProjectsLocationsFirewallEndpointAssociations({ name })
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
  "getProjectsLocationsFirewallEndpointAssociations on a missing association fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const project = process.env.GOOGLE_PROJECT_ID ?? "";
      const error = yield* Effect.flip(
        networksecurity.getProjectsLocationsFirewallEndpointAssociations({
          name: `projects/${project}/locations/us-central1-a/firewallEndpointAssociations/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a firewall endpoint association",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* GCP.Compute.Network("Vpc", {
            autoCreateSubnetworks: false,
            description: "association vpc",
          });
          const endpoint = yield* GCP.Networksecurity.FirewallEndpoint("Ngfw", {
            location: "us-central1-a",
            description: "association endpoint",
            labels: { env: "test" },
          });
          const association =
            yield* GCP.Networksecurity.FirewallEndpointAssociation("Inspect", {
              location: "us-central1-a",
              firewallEndpoint: endpoint.name,
              network: vpc.selfLink.as<string>(),
              labels: { env: "test" },
            });
          return { vpc, endpoint, association };
        }),
      );

      expect(created.association.name).toContain(
        "/firewallEndpointAssociations/",
      );
      expect(created.association.location).toEqual("us-central1-a");
      expect(created.association.disabled).toEqual(false);
      expect(created.association.labels).toMatchObject({ env: "test" });
      expect(created.association.firewallEndpoint).toEqual(
        created.endpoint.name,
      );

      const fetched =
        yield* networksecurity.getProjectsLocationsFirewallEndpointAssociations(
          {
            name: created.association.name,
          },
        );
      expect(fetched.name).toEqual(created.association.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* GCP.Compute.Network("Vpc", {
            networkName: created.vpc.networkName,
            autoCreateSubnetworks: false,
            description: "association vpc",
          });
          const endpoint = yield* GCP.Networksecurity.FirewallEndpoint("Ngfw", {
            firewallEndpointId: created.endpoint.firewallEndpointId,
            location: "us-central1-a",
            description: "association endpoint",
            labels: { env: "test" },
          });
          const association =
            yield* GCP.Networksecurity.FirewallEndpointAssociation("Inspect", {
              firewallEndpointAssociationId:
                created.association.firewallEndpointAssociationId,
              location: "us-central1-a",
              firewallEndpoint: endpoint.name,
              network: vpc.selfLink.as<string>(),
              disabled: true,
              labels: { env: "prod", role: "ngfw" },
            });
          return { vpc, endpoint, association };
        }),
      );

      expect(updated.association.name).toEqual(created.association.name);
      expect(updated.association.disabled).toEqual(true);
      expect(updated.association.labels).toMatchObject({
        env: "prod",
        role: "ngfw",
      });

      const refetched =
        yield* networksecurity.getProjectsLocationsFirewallEndpointAssociations(
          {
            name: created.association.name,
          },
        );
      expect(refetched.disabled).toEqual(true);
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("ngfw");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.association.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
