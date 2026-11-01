import {
  diffMigrations,
  migrationAttributesOf,
  migrationsAttrs,
  migrationsInputOf,
  stampedOf,
  type MigrationAttributes,
  type MigrationsInput,
} from "@alchemy.run/sql/Migrations";
import type * as mariadb from "@distilled.cloud/stackit/mariadb";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { StackitEnvironment } from "../Environment.ts";
import {
  commonParameters,
  definedParameters,
  makeInstanceLifecycle,
} from "../internal/dataServices.ts";
import type { Providers } from "../Providers.ts";
import { INSTANCE_LABEL, instanceApi, type MariaDBError } from "./internal.ts";
import { runInstanceMigrations } from "./Migrations.ts";

export interface InstanceProps {
  /**
   * Name of the instance. Changing it replaces the instance; removing it keeps the
   * current name.
   *
   * @default a unique name generated from the stack, stage and logical ID
   */
  name?: string;
  /**
   * Offering version, e.g. `10.11`. With `planName` it selects the plan from the
   * offerings the API lists for the project. Updates in place.
   */
  version: string;
  /**
   * Plan name, e.g. `stackit-mariadb-1.2.10-replica`. A deploy fails with
   * `DataServicePlanNotFound`, listing the choices, when no such plan exists. Updates
   * in place.
   */
  planName: string;
  /**
   * IPv4 CIDR ranges allowed to connect, e.g. `203.0.113.7/32`. Anything else can't
   * open a connection, including the machine that runs `migrations` and any host
   * using `Stackit.MariaDB.Connect`. Updates in place. Leave it unset to keep
   * STACKIT's default ranges.
   */
  acl?: string[];
  /**
   * Key that encrypts backups. The API can't read it back, so it is sent when it
   * differs from the last deploy's. Removing it leaves the key in place.
   */
  backupEncryptionKey?: string | Redacted.Redacted<string>;
  /** Whether updates install automatically. Leave it unset to keep the live setting. */
  automaticUpdates?: boolean;
  /** Turn on monitoring. Leave it unset to keep the API's default. */
  enableMonitoring?: boolean;
  /** Observability instance receiving the monitoring data. */
  monitoringInstanceId?: string;
  /** Graphite endpoint for metrics, as `host:port`. */
  graphite?: string;
  /** Seconds between emitted metrics. */
  metricsFrequency?: number;
  /** Prefix of emitted metrics. Some Graphite providers expect an API key here. */
  metricsPrefix?: string | Redacted.Redacted<string>;
  /** Percent of disk usage at which STACKIT's disk guard stops the service's processes. */
  maxDiskThreshold?: number;
  /** Syslog drains, as `host:port`. */
  syslog?: string[];
  /**
   * SQL migrations to apply on deploy, once the instance is active. Accepts a
   * directory (`"./migrations"`), a directory with a custom bookkeeping table
   * (`{ dir, table }`), or a `Drizzle.Schema`. Only pending files run; editing or
   * removing an applied file fails the deploy.
   *
   * Each run creates a credential, migrates over a direct connection from the
   * deploying machine, and deletes the credential, so its public IP has to be in
   * `acl`. Alchemy doesn't open the ACL for you. Install `mysql2` to use them.
   *
   * Define views and stored routines with `SQL SECURITY INVOKER`: the credential that
   * ran the migration is deleted afterwards, so a `DEFINER` naming its user may no
   * longer resolve.
   */
  migrations?: MigrationsInput;
  /** Project that owns the instance. Changing it replaces the instance. @default the profile's project */
  projectId?: string;
  /** Region of the instance. Changing it replaces the instance. @default the profile's region */
  region?: string;
}

export interface InstanceAttributes extends MigrationAttributes {
  /** STACKIT instance id. Stable across updates. */
  instanceId: string;
  /** Project that owns the instance. */
  projectId: string;
  /** Region of the instance. */
  region: string;
  /** Name of the instance. */
  name: string;
  /** Offering version. */
  version: string;
  /** Id of the plan. */
  planId: string;
  /** Name of the plan. */
  planName: string;
  /** IPv4 CIDR ranges allowed to connect, as the instance reports them. */
  acl: string[];
  /** Instance parameters as the API reports them, without `metrics_prefix`. */
  parameters: Record<string, unknown>;
  /** Name of the offering. */
  offeringName: string;
  /** Image of the offering. */
  imageUrl: string;
  /** URL of the instance's dashboard. */
  dashboardUrl: string;
  /** Cloud Foundry GUID of the instance. */
  cfGuid: string;
  /** Cloud Foundry GUID of its space. */
  cfSpaceGuid: string;
  /** Cloud Foundry GUID of its organization. */
  cfOrganizationGuid: string;
  /** State of the instance and its last operation; `active` after a deploy. */
  status: string | undefined;
  /** State of the service instance itself. */
  instanceStatus: string | undefined;
  /** The last operation, whose description holds the reason for a failure. */
  lastOperation: { type: string; state: string; description: string };
  /** Whether updates install automatically, when the props set it. */
  automaticUpdates: boolean | undefined;
}

export type Instance = Resource<
  "Stackit.MariaDB.Instance",
  InstanceProps,
  InstanceAttributes,
  never,
  Providers
>;

/**
 * A managed MariaDB instance on STACKIT. The API has no operations for databases or
 * users: connection details, including the database's name, come from a
 * `Stackit.MariaDB.Credential`.
 *
 * Version, plan, ACL and the other parameters update in place. Name, project and
 * region replace the instance, and a replacement starts empty: back up what you need
 * first. Removing a parameter prop leaves its live value as it is, since the API
 * keeps what an update leaves out. Deploys wait until the instance reports `active`,
 * which takes minutes.
 *
 * This API has no labels. Alchemy knows an instance as its own by the id in state and
 * by the generated name, which holds the generation's id. An instance with an explicit
 * name and no state is reported as unowned, including one a deploy created before it
 * crashed: redeploy with `--adopt`, or delete it by hand. `alchemy unsafe nuke` only
 * finds generated names.
 *
 * Instances are billed per started hour by plan.
 *
 * ### Creating an Instance
 * **Example:** A single instance
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const db = yield* Stackit.MariaDB.Instance("Db", {
 *   version: "10.11",
 *   planName: "stackit-mariadb-1.2.10-replica",
 *   acl: ["203.0.113.7/32"],
 * });
 * ```
 *
 * ### Configuring an Instance
 * **Example:** Monitoring, automatic updates and an encryption key for backups
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Redacted from "effect/Redacted";
 *
 * const db = yield* Stackit.MariaDB.Instance("Db", {
 *   name: "orders-production",
 *   version: "10.11",
 *   planName: "stackit-mariadb-1.2.10-replica",
 *   acl: ["203.0.113.0/24"],
 *   automaticUpdates: true,
 *   backupEncryptionKey: Redacted.make("a-key-you-manage"),
 *   enableMonitoring: true,
 *   metricsFrequency: 60,
 *   syslog: ["logs.example.com:54321"],
 * });
 * ```
 *
 * ### Migrations
 * **Example:** Apply migrations from a directory
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // A credential is created for the run and deleted after it. This machine's public
 * // IP has to be in the ACL.
 * const db = yield* Stackit.MariaDB.Instance("Db", {
 *   version: "10.11",
 *   planName: "stackit-mariadb-1.2.10-replica",
 *   acl: ["203.0.113.7/32"],
 *   migrations: "./migrations",
 * });
 * ```
 *
 * ### Connecting
 * **Example:** A credential for an application
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const db = yield* Stackit.MariaDB.Instance("Db", {
 *   version: "10.11",
 *   planName: "stackit-mariadb-1.2.10-replica",
 *   acl: ["203.0.113.7/32"],
 * });
 * const credential = yield* Stackit.MariaDB.Credential("App", {
 *   instanceId: db.instanceId,
 * });
 * ```
 *
 * ### Replacement Cautions
 * **Example:** A new name creates a new, empty instance
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // The old instance and its data are deleted once the new one is up, so move data
 * // out first.
 * const db = yield* Stackit.MariaDB.Instance("Db", {
 *   name: "orders-v2",
 *   version: "10.11",
 *   planName: "stackit-mariadb-1.2.10-replica",
 *   acl: ["203.0.113.7/32"],
 * });
 * ```
 *
 * @resource
 * @product STACKIT MariaDB
 * @category MariaDB
 */
export const Instance = Resource<Instance>("Stackit.MariaDB.Instance");

const parametersOf = (props: InstanceProps): mariadb.InstanceParameters =>
  definedParameters(commonParameters(props));

export const InstanceProvider = () => {
  const lifecycle = makeInstanceLifecycle<
    MariaDBError,
    mariadb.StackitOpContext,
    mariadb.InstanceParameters,
    InstanceProps,
    InstanceAttributes
  >({
    label: INSTANCE_LABEL,
    api: instanceApi,
    parametersOf,
    attributes: (base, prior) => ({ ...base, ...migrationAttributesOf(prior) }),
  });

  return Provider.succeed(Instance, {
    stables: ["instanceId", "projectId", "region", "name"],
    // Nuke ordering: `Credential` declares a dependency on this type, so it goes first.

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      return yield* lifecycle.list({ projectId: env.projectId, region: env.region });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      const identity = yield* lifecycle.diffIdentity(news, output);
      if (identity !== undefined) return identity;
      if (!isResolved(news)) return undefined;
      // Pending files or a table move update in place, never replace.
      if (yield* diffMigrations({ news, output })) return { action: "update" } as const;
      // Everything else updates in place (engine default: props changed).
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      return yield* lifecycle.read({ id, olds, output, previous });
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const attrs = yield* lifecycle.reconcile({ id, news, olds, output });
      // Migrations last, once the instance is active and every other aspect is synced.
      const migrationsInput = migrationsInputOf(news);
      const run = migrationsInput
        ? yield* runInstanceMigrations({
            scope: { projectId: attrs.projectId, region: attrs.region },
            instanceId: attrs.instanceId,
            instanceName: attrs.name,
            input: migrationsInput,
            stamped: stampedOf(output),
          })
        : undefined;
      return { ...attrs, ...migrationsAttrs({ input: migrationsInput, run, output }) };
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* lifecycle.delete(output);
    }),
  });
};
