/** A cron: every two seconds, once across the cluster. */
import * as Cluster from "@alchemy.run/cluster";

export class Tick extends Cluster.Cron<Tick>()("Tick", { cron: "*/2 * * * * *" }) {}
