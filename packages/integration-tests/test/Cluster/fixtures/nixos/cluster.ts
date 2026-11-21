/**
 * The NixOS fixture: a greeter and a cron. With `CLUSTER_NIXOS_HOST` the
 * pool deploys them to that host; without it a process pool writes the
 * same runner to a directory, the fixture of the module's VM test.
 */
import * as os from "node:os";
import * as path from "node:path";
import * as Cluster from "@alchemy.run/effect-cluster";
import * as ClusterNixOS from "@alchemy.run/effect-cluster/NixOS";
import * as ClusterProcess from "@alchemy.run/effect-cluster/Process";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

/** The pool's name, which the host enables as `services.effect-cluster.pools.nixos-test`. */
export const POOL_NAME = "nixos-test";

/** The host to deploy to, as `ssh` reaches it. */
export const HOST = process.env.CLUSTER_NIXOS_HOST;

/** Extra `ssh` options, e.g. `-F <config>`. */
export const SSH_OPTIONS = process.env.CLUSTER_NIXOS_SSH_OPTIONS?.split(" ").filter(Boolean) ?? [];

/** The ssh user is not root: activate with `sudo -n`. */
export const SUDO = process.env.CLUSTER_NIXOS_SUDO === "1";

export const FIXTURE_DIR =
  process.env.CLUSTER_NIXOS_FIXTURE_DIR ?? path.join(os.tmpdir(), "alchemy-cluster-nixos");

/** PostgreSQL on the host, over its socket (`database.createLocally`). */
export const DATABASE_URL = `postgres://effect-cluster-${POOL_NAME}@localhost/effect-cluster-${POOL_NAME}?host=/run/postgresql`;

export const Database = Cluster.Database.fromUrl({ url: Redacted.make(DATABASE_URL) });

export const Default = (
  HOST === undefined
    ? ClusterProcess.ProcessPool("Default", { dir: FIXTURE_DIR })
    : ClusterNixOS.HostPool("Default", {
        name: POOL_NAME,
        host: HOST,
        sshOptions: SSH_OPTIONS,
        sudo: SUDO,
      })
).pipe(Layer.provide(Database));
