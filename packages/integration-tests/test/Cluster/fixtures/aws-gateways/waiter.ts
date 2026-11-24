/**
 * Entities whose calls stay open: `Sleep` answers after `seconds`, and
 * `Drip` streams `count` values `gapSeconds` apart. One type per pool, so
 * each gateway carries its own calls.
 */
import * as Cluster from "@alchemy.run/effect-cluster";
import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";

const rpcs = [
  Rpc.make("Sleep", { payload: { seconds: Schema.Number }, success: Schema.Number }),
  Rpc.make("Drip", {
    payload: { count: Schema.Int, gapSeconds: Schema.Number },
    success: Schema.Int,
    stream: true,
  }),
] as const;

/** Behind an internal load balancer. */
export class PrivateWaiters extends Cluster.Entity<PrivateWaiters>()("PrivateWaiter", rpcs) {}

/** Behind CloudFront. */
export class EdgeWaiters extends Cluster.Entity<EdgeWaiters>()("EdgeWaiter", rpcs) {}

/** Behind a load balancer serving HTTPS on a domain. */
export class SecureWaiters extends Cluster.Entity<SecureWaiters>()("SecureWaiter", rpcs) {}
