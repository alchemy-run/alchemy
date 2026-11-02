/** A cron: once per scheduled time across the cluster. */
import * as Cluster from "@alchemy.run/cluster";

export class Tick extends Cluster.Cron<Tick>()("Tick") {}
