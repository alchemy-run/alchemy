import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";

/**
 * Managed Microsoft AD resources the generated bindings bind. Its reserved
 * range differs from Domain.test.ts's so the two domains can share the
 * `default` network.
 */
export const ProbeDomain = GCP.ManagedIdentities.Domain("ProbeDomain", {
  reservedIpRange: "172.16.1.0/24",
  locations: ["us-central1"],
  authorizedNetworks: ["default"],
});
export const ProbeBackup = Effect.gen(function* () {
  const domain = yield* ProbeDomain;
  return yield* GCP.ManagedIdentities.DomainsBackup("ProbeBackup", {
    domain: domain.name,
  });
});
