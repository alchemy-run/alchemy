/** A pool of plain-process runners, written to a directory a test reads. */
import * as os from "node:os";
import * as path from "node:path";
import * as Cluster from "@alchemy.run/effect-cluster";
import * as ClusterProcess from "@alchemy.run/effect-cluster/Process";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

export const RUNNER_DIR =
  process.env.CLUSTER_PROCESS_DIR ?? path.join(os.tmpdir(), "alchemy-cluster-process");

/** A real Postgres when set, which the end-to-end case runs a runner against. */
export const DATABASE_URL =
  process.env.CLUSTER_PROCESS_DATABASE_URL ?? "postgres://cluster@127.0.0.1/cluster";

export const Database = Cluster.Database.fromUrl({ url: Redacted.make(DATABASE_URL) });

export const Default = ClusterProcess.ProcessPool("Default", { dir: RUNNER_DIR }).pipe(
  Layer.provide(Database),
);
