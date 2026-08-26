import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
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
const region = "us-central1";

const waitUntilGone = (compositeHealthCheck: string) =>
  compute
    .getRegionCompositeHealthChecks({
      project,
      region,
      compositeHealthCheck,
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider.skipIf(!hasGcpCreds)(
  "getRegionCompositeHealthChecks on a missing check fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        compute.getRegionCompositeHealthChecks({
          project,
          region,
          compositeHealthCheck: "alchemy-missing-chc",
        }),
      );
      expect(error._tag).toBe("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "probe insertRegionCompositeHealthChecks entitlement",
  () =>
    Effect.gen(function* () {
      const result = yield* compute
        .insertRegionCompositeHealthChecks({
          project,
          region,
          body: {
            name: "alchemy-chc-probe",
            description: "alchemy entitlement probe",
            healthDestination: `projects/${project}/regions/${region}/forwardingRules/does-not-exist`,
            healthSources: [
              `projects/${project}/regions/${region}/healthSources/does-not-exist`,
            ],
          },
        })
        .pipe(
          Effect.map(() => ({ tag: "ok" as const })),
          Effect.catchTag("Forbidden", (error) =>
            Effect.succeed({
              tag: "Forbidden" as const,
              message: error.message,
            }),
          ),
          Effect.catchTag("BadRequest", (error) =>
            Effect.succeed({
              tag: "BadRequest" as const,
              message: error.message,
            }),
          ),
          Effect.catchTag("NotFound", (error) =>
            Effect.succeed({
              tag: "NotFound" as const,
              message: error.message,
            }),
          ),
        );
      if (result.tag === "ok") {
        yield* compute
          .deleteRegionCompositeHealthChecks({
            project,
            region,
            compositeHealthCheck: "alchemy-chc-probe",
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
        return;
      }
      expect(["Forbidden", "BadRequest", "NotFound"]).toContain(result.tag);
    }).pipe(logLevel),
  { timeout: 60_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create, update, and delete a regional composite health check",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const network = yield* GCP.Compute.Network("Vpc", {
            autoCreateSubnetworks: false,
          });
          const subnet = yield* GCP.Compute.Subnetwork("IlbSubnet", {
            network: network.networkName,
            region,
            ipCidrRange: "10.54.0.0/24",
          });
          const check = yield* GCP.Compute.RegionHealthCheck("Probe", {
            region,
            description: "tcp probe",
            type: "TCP",
            tcpHealthCheck: { port: 80 },
          });
          const backend = yield* GCP.Compute.RegionBackendService(
            "IlbBackend",
            {
              region,
              protocol: "TCP",
              loadBalancingScheme: "INTERNAL",
              network: network.selfLink.as<string>(),
              healthChecks: [check.selfLink.as<string>()],
              description: "ilb backend",
            },
          );
          const rule = yield* GCP.Compute.ForwardingRule("IlbRule", {
            region,
            loadBalancingScheme: "INTERNAL",
            backendService: backend.selfLink.as<string>(),
            network: network.selfLink.as<string>(),
            subnetwork: subnet.selfLink.as<string>(),
            ipProtocol: "TCP",
            allPorts: true,
          });
          const policy = yield* GCP.Compute.RegionHealthAggregationPolicy(
            "Agg",
            { region, description: "backend rollup" },
          );
          const source = yield* GCP.Compute.RegionHealthSource("Src", {
            region,
            sources: [backend.selfLink.as<string>()],
            healthAggregationPolicy: policy.selfLink.as<string>(),
            description: "ilb source",
          });
          const composite = yield* GCP.Compute.RegionCompositeHealthCheck(
            "Comp",
            {
              region,
              healthDestination: rule.selfLink.as<string>(),
              healthSources: [source.selfLink.as<string>()],
              description: "and backends",
            },
          );
          return {
            network,
            subnet,
            check,
            backend,
            rule,
            policy,
            source,
            composite,
          };
        }),
      );

      expect(created.composite.healthCheckName).toEqual(expect.any(String));
      expect(created.composite.region).toEqual(region);
      expect(created.composite.description).toEqual("and backends");
      expect(created.composite.healthSources.length).toBeGreaterThan(0);

      const fetched = yield* compute.getRegionCompositeHealthChecks({
        project: created.composite.project,
        region,
        compositeHealthCheck: created.composite.healthCheckName,
      });
      expect(fetched.name).toEqual(created.composite.healthCheckName);
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.description).toContain("and backends");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const network = yield* GCP.Compute.Network("Vpc", {
            networkName: created.network.networkName,
            autoCreateSubnetworks: false,
          });
          const subnet = yield* GCP.Compute.Subnetwork("IlbSubnet", {
            subnetworkName: created.subnet.subnetworkName,
            network: network.networkName,
            region,
            ipCidrRange: "10.54.0.0/24",
          });
          const check = yield* GCP.Compute.RegionHealthCheck("Probe", {
            healthCheckName: created.check.healthCheckName,
            region,
            description: "tcp probe",
            type: "TCP",
            tcpHealthCheck: { port: 80 },
          });
          const backend = yield* GCP.Compute.RegionBackendService(
            "IlbBackend",
            {
              name: created.backend.name,
              region,
              protocol: "TCP",
              loadBalancingScheme: "INTERNAL",
              network: network.selfLink.as<string>(),
              healthChecks: [check.selfLink.as<string>()],
              description: "ilb backend",
            },
          );
          const rule = yield* GCP.Compute.ForwardingRule("IlbRule", {
            forwardingRuleName: created.rule.forwardingRuleName,
            region,
            loadBalancingScheme: "INTERNAL",
            backendService: backend.selfLink.as<string>(),
            network: network.selfLink.as<string>(),
            subnetwork: subnet.selfLink.as<string>(),
            ipProtocol: "TCP",
            allPorts: true,
          });
          const policy = yield* GCP.Compute.RegionHealthAggregationPolicy(
            "Agg",
            {
              policyName: created.policy.policyName,
              region,
              description: "backend rollup",
            },
          );
          const source = yield* GCP.Compute.RegionHealthSource("Src", {
            sourceName: created.source.sourceName,
            region,
            sources: [backend.selfLink.as<string>()],
            healthAggregationPolicy: policy.selfLink.as<string>(),
            description: "ilb source",
          });
          return yield* GCP.Compute.RegionCompositeHealthCheck("Comp", {
            healthCheckName: created.composite.healthCheckName,
            region,
            healthDestination: rule.selfLink.as<string>(),
            healthSources: [source.selfLink.as<string>()],
            description: "updated composite",
          });
        }),
      );

      expect(updated.healthCheckName).toEqual(
        created.composite.healthCheckName,
      );
      expect(updated.description).toEqual("updated composite");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.composite.healthCheckName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 180_000 },
);
