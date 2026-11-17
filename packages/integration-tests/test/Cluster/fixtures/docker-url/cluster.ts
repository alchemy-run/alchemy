/**
 * A pool on a database it is given by URL (`Cluster.Database.fromUrl`), which
 * is on no Docker network: the runners join the network Postgres is on.
 */
import * as Docker from "@alchemy.run/docker";
import * as Cluster from "@alchemy.run/effect-cluster";
import * as ClusterDocker from "@alchemy.run/effect-cluster/Docker";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

export const FRONT_PORT = 18640;

const DB_HOST = "url-db";

export const Network = Docker.Network("UrlNetwork", { driver: "overlay" });

/** A Postgres the cluster did not create, reachable on `Network`. */
export const Postgres = Effect.gen(function* () {
  const network = yield* Network;
  return yield* Docker.Service("UrlPostgres", {
    image: ClusterDocker.DEFAULT_POSTGRES_IMAGE,
    environment: { POSTGRES_PASSWORD: "cluster", POSTGRES_DB: "cluster" },
    networks: [{ name: network.name, aliases: [DB_HOST] }],
    replicas: 1,
  });
});

export const Database = Cluster.Database.fromUrl({
  url: Redacted.make(`postgres://postgres:cluster@${DB_HOST}:5432/cluster`),
});

export const Default = ClusterDocker.SwarmPool("UrlPool", { network: Network }).pipe(
  Layer.provide(Database),
);
