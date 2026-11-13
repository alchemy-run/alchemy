import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import {
  getDatabaseConnectionPool,
  getDatabaseUser,
  listDatabaseFirewallRules,
} from "@distilled.cloud/digitalocean";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isGone, logLevel, skipSlow } from "../support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:databases", "live"];
const LIVE_TIMEOUT = 1_800_000;

// One cluster carries a user, a pool and trusted sources, because each
// cluster takes minutes to provision.
test.provider.skipIf(skipSlow)(
  "user, connection pool and firewall: create, update in place, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const declare = (poolSize: number, office: string) =>
        Effect.gen(function* () {
          const cluster = yield* DigitalOcean.Databases.Cluster("Cluster", {
            engine: "pg",
            size: "db-s-1vcpu-1gb",
            region: "nyc3",
          });
          const database = yield* DigitalOcean.Databases.Database("App", {
            clusterId: cluster.clusterId,
            name: "app",
          });
          const user = yield* DigitalOcean.Databases.User("AppUser", {
            clusterId: cluster.clusterId,
            name: "app_user",
          });
          const pool = yield* DigitalOcean.Databases.ConnectionPool("Pool", {
            clusterId: cluster.clusterId,
            name: "app_pool",
            database: database.name,
            user: user.name,
            size: poolSize,
          });
          const firewall = yield* DigitalOcean.Databases.Firewall("Firewall", {
            clusterId: cluster.clusterId,
            rules: [{ type: "ip_addr", value: office }],
          });
          return { cluster, user, pool, firewall };
        });

      const created = yield* stack.deploy(declare(5, "203.0.113.0/24"));
      const clusterId = created.cluster.clusterId;
      expect(created.user.name).toEqual("app_user");
      expect(Redacted.value(created.user.password!).length).toBeGreaterThan(8);
      expect(Redacted.value(created.pool.uri!)).toMatch(/\/app_pool\?/);
      expect(
        (yield* listDatabaseFirewallRules({ database_cluster_uuid: clusterId })).rules.map(
          (rule) => rule.value,
        ),
      ).toEqual(["203.0.113.0/24"]);

      yield* stack.deploy(declare(10, "198.51.100.0/24"));
      const pool = yield* getDatabaseConnectionPool({
        database_cluster_uuid: clusterId,
        pool_name: "app_pool",
      });
      expect(pool.pool.size).toEqual(10);
      expect(
        (yield* listDatabaseFirewallRules({ database_cluster_uuid: clusterId })).rules.map(
          (rule) => rule.value,
        ),
      ).toEqual(["198.51.100.0/24"]);

      yield* stack.destroy();

      expect(
        yield* isGone(getDatabaseUser({ database_cluster_uuid: clusterId, username: "app_user" })),
      ).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);
