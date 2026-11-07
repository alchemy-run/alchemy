import * as GCP from "@alchemy.run/gcp";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";

/** A scan config over a reserved IP; it is never started, so it never scans. */
export const ProbeScanConfig = Effect.gen(function* () {
  const ip = yield* GCP.Compute.Address("ProbeScannerIp", { region: "us-central1" });
  return yield* GCP.WebSecurityScanner.ScanConfig("ProbeScan", {
    displayName: "alchemy probe",
    startingUrls: [Output.interpolate`http://${ip.address}`],
    targetPlatforms: ["COMPUTE"],
    exportToSecurityCommandCenter: "DISABLED",
  });
});
