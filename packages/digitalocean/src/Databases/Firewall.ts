import * as DO from "@distilled.cloud/digitalocean";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { setEquals } from "../internal/equal.ts";
import type { Providers } from "../Providers.ts";
import { waitUntilOnline } from "./Cluster.ts";

export type FirewallRuleType = "ip_addr" | "droplet" | "k8s" | "tag" | "app";

export type FirewallRule = {
  /** What `value` names. */
  type: FirewallRuleType;
  /** An IP or CIDR, a droplet id, a Kubernetes cluster id, a droplet tag, or an App Platform app id. */
  value: string;
};

export type FirewallProps = {
  /** The cluster whose trusted sources these are. A change moves the rules. */
  clusterId: string;
  /**
   * Sources allowed to connect. Every other source is refused. An empty
   * list allows connections from anywhere.
   */
  rules: FirewallRule[];
};

export type Firewall = Resource<
  "DigitalOcean.Databases.Firewall",
  FirewallProps,
  {
    /** The cluster. */
    clusterId: string;
    /** The trusted sources. */
    rules: FirewallRule[];
  },
  never,
  Providers
>;

/**
 * The trusted sources of a Managed Database cluster: only these droplets,
 * tags, Kubernetes clusters, apps and addresses may connect. The rules are
 * replaced as a whole on every change. Destroying the resource removes the
 * restriction, so any source may connect again.
 *
 * Deploys that apply `Database` migrations connect from the deploying
 * machine, so include its address while migrations run.
 *
 * ### Restricting Access
 * **Example:** Allow one droplet and an office network
 * ```typescript
 * const pg = yield* DigitalOcean.Databases.Cluster("db", {
 *   engine: "pg",
 *   size: "db-s-1vcpu-1gb",
 *   region: "nyc3",
 * });
 * const host = yield* DigitalOcean.Droplet("app", {
 *   region: "nyc3",
 *   size: "s-1vcpu-1gb",
 *   image: "ubuntu-24-04-x64",
 * });
 * yield* DigitalOcean.Databases.Firewall("db-firewall", {
 *   clusterId: pg.clusterId,
 *   rules: [
 *     { type: "droplet", value: String(host.dropletId) },
 *     { type: "ip_addr", value: "203.0.113.0/24" },
 *   ],
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#operation/databases_update_firewall_rules
 *
 * @resource
 * @product Managed Databases
 * @category Databases
 */
export const Firewall = Resource<Firewall>("DigitalOcean.Databases.Firewall");

const ruleKey = (rule: { type: string; value: string }) => `${rule.type}\0${rule.value}`;

const observe = (clusterId: string) =>
  DO.listDatabaseFirewallRules({ database_cluster_uuid: clusterId }).pipe(
    Effect.map((r) => r.rules.map((rule) => ({ type: rule.type, value: rule.value }))),
  );

const replaceRules = (clusterId: string, rules: ReadonlyArray<FirewallRule>) =>
  DO.updateDatabaseFirewallRules({
    database_cluster_uuid: clusterId,
    rules: rules.map((rule) => ({ type: rule.type, value: rule.value })),
  });

export const FirewallProvider = () =>
  Provider.succeed(Firewall, {
    stables: ["clusterId"],
    read: Effect.fn(function* ({ olds, output }) {
      const clusterId = output?.clusterId ?? olds.clusterId;
      const rules = yield* observe(clusterId).pipe(
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      );
      if (rules === undefined || rules.length === 0) return undefined;
      return { clusterId, rules };
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      yield* waitUntilOnline(news.clusterId);
      const observed = yield* observe(news.clusterId);
      if (!setEquals(observed.map(ruleKey), news.rules.map(ruleKey))) {
        yield* replaceRules(news.clusterId, news.rules);
      }
      // Rules moved to another cluster leave the old one open again.
      if (output !== undefined && output.clusterId !== news.clusterId) {
        yield* replaceRules(output.clusterId, []).pipe(
          Effect.catchTag("NotFound", () => Effect.void),
        );
      }
      return { clusterId: news.clusterId, rules: news.rules };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* replaceRules(output.clusterId, []).pipe(
        Effect.catchTag("NotFound", () => Effect.void),
      );
    }),
  });
