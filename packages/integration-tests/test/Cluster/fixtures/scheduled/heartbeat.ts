/** A singleton: one heartbeat across the cluster. */
import * as Cluster from "@alchemy.run/cluster";

export class Heartbeat extends Cluster.Singleton<Heartbeat>()("Heartbeat") {}
