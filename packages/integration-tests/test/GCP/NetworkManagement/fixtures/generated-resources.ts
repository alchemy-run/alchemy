import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import * as Effect from "effect/Effect";
import { defaultNetworkSelfLink } from "../../networkQuota.ts";

/** NetworkManagement resources the generated bindings bind. */

export const ProbeConnectivityTest = Effect.gen(function* () {
  const { project } = yield* GcpEnvironment.current;
  return yield* GCP.NetworkManagement.ConnectivityTest("ProbeConnectivityTest", {
    source: {
      ipAddress: "10.8.0.1",
      network: defaultNetworkSelfLink(project),
      networkType: "GCP_NETWORK",
      projectId: project,
    },
    destination: { ipAddress: "10.8.0.2", port: 443 },
    protocol: "TCP",
  });
});
export const ProbeFlowLogs = Effect.gen(function* () {
  const { project } = yield* GcpEnvironment.current;
  return yield* GCP.NetworkManagement.VpcFlowLogsConfig("ProbeFlowLogs", {
    network: defaultNetworkSelfLink(project),
    aggregationInterval: "INTERVAL_5_SEC",
    flowSampling: 1,
  });
});
