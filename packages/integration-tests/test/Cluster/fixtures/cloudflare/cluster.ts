/** The runners every fixture entity runs on: Durable Objects on one Worker. */
import * as ClusterCloudflare from "@alchemy.run/effect-cluster/Cloudflare";

export const Default = ClusterCloudflare.Runners("Default");
