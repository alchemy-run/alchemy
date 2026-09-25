import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as vmwareengine from "@distilled.cloud/gcp/vmwareengine_v1";
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
  hasGcpCreds && !!process.env.GCP_TEST_VMWAREENGINE && !process.env.FAST;

const project = process.env.GOOGLE_PROJECT_ID ?? "";

const waitUntilGone = (name: string) =>
  vmwareengine
    .getProjectsLocationsNetworkPoliciesExternalAccessRules({ name })
    .pipe(
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
  "getProjectsLocationsNetworkPoliciesExternalAccessRules on a missing rule fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        vmwareengine.getProjectsLocationsNetworkPoliciesExternalAccessRules({
          name: `projects/${project}/locations/us-central1/networkPolicies/alchemy-missing/externalAccessRules/missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_VMWAREENGINE)(
  "createProjectsLocationsNetworkPoliciesExternalAccessRules without entitlement fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        vmwareengine.createProjectsLocationsNetworkPoliciesExternalAccessRules({
          parent: `projects/${project}/locations/us-central1/networkPolicies/alchemy-missing`,
          externalAccessRuleId: "alchemy-ear-probe",
          validateOnly: true,
          body: {
            action: "ALLOW",
            ipProtocol: "tcp",
            priority: 1000,
            sourceIpRanges: [{ ipAddressRange: "0.0.0.0/0" }],
            destinationIpRanges: [{ ipAddressRange: "0.0.0.0/0" }],
            sourcePorts: ["0-65535"],
            destinationPorts: ["443"],
            description: "alchemy probe",
          },
        }),
      );
      expect(["Forbidden", "NotFound", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an external access rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const ven = yield* GCP.Vmwareengine.VmwareEngineNetwork("Ven", {
            type: "STANDARD",
            description: "rule grandparent",
          });
          const policy = yield* GCP.Vmwareengine.NetworkPolicy("Edge", {
            vmwareEngineNetwork: ven.name,
            edgeServicesCidr: "192.168.100.0/26",
            internetAccess: { enabled: true },
            externalIp: { enabled: true },
            description: "rule parent",
          });
          const rule =
            yield* GCP.Vmwareengine.NetworkPoliciesExternalAccessRule("Https", {
              networkPolicy: policy.name,
              action: "ALLOW",
              ipProtocol: "tcp",
              priority: 1000,
              sourceIpRanges: [{ ipAddressRange: "0.0.0.0/0" }],
              destinationIpRanges: [{ ipAddressRange: "0.0.0.0/0" }],
              destinationPorts: ["443"],
              description: "alchemy-test-ear",
            });
          return { ven, policy, rule };
        }),
      );

      expect(created.rule.name).toContain("/externalAccessRules/");
      expect(created.rule.action).toEqual("ALLOW");
      expect(created.rule.priority).toEqual(1000);
      expect(created.rule.description).toEqual("alchemy-test-ear");

      const fetched =
        yield* vmwareengine.getProjectsLocationsNetworkPoliciesExternalAccessRules(
          { name: created.rule.name },
        );
      expect(fetched.name).toEqual(created.rule.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("alchemy-test-ear");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const ven = yield* GCP.Vmwareengine.VmwareEngineNetwork("Ven", {
            vmwareEngineNetworkId: created.ven.vmwareEngineNetworkId,
            type: "STANDARD",
            description: "rule grandparent",
          });
          const policy = yield* GCP.Vmwareengine.NetworkPolicy("Edge", {
            networkPolicyId: created.policy.networkPolicyId,
            vmwareEngineNetwork: ven.name,
            edgeServicesCidr: "192.168.100.0/26",
            internetAccess: { enabled: true },
            externalIp: { enabled: true },
            description: "rule parent",
          });
          const rule =
            yield* GCP.Vmwareengine.NetworkPoliciesExternalAccessRule("Https", {
              networkPolicy: policy.name,
              externalAccessRuleId: created.rule.externalAccessRuleId,
              action: "DENY",
              ipProtocol: "tcp",
              priority: 2000,
              sourceIpRanges: [{ ipAddressRange: "0.0.0.0/0" }],
              destinationIpRanges: [{ ipAddressRange: "0.0.0.0/0" }],
              destinationPorts: ["443"],
              description: "alchemy-prod-ear",
            });
          return { ven, policy, rule };
        }),
      );

      expect(updated.rule.name).toEqual(created.rule.name);
      expect(updated.rule.action).toEqual("DENY");
      expect(updated.rule.priority).toEqual(2000);
      expect(updated.rule.description).toEqual("alchemy-prod-ear");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.rule.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
