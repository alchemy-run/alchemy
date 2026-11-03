/** The pool every fixture entity runs in: Durable Objects on one Worker. */
import * as ClusterCloudflare from "@alchemy.run/effect-cluster/Cloudflare";

export const Default = ClusterCloudflare.DurableObjectPool("Default");
