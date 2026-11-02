/** A cron: once per scheduled time across the cluster. */
import * as Cluster from "@alchemy.run/effect-cluster";

export class Tick extends Cluster.Cron<Tick>()("Tick") {}
