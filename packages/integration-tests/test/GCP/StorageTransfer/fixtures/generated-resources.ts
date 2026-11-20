import * as GCP from "@alchemy.run/gcp";

/** Resources the generated Storage Transfer bindings bind. */
export { Copy } from "./bindings-host.ts";

export const ProbePool = GCP.StorageTransfer.AgentPool("ProbePool", {
  displayName: "probe pool",
});
