import type * as rabbitmq from "@distilled.cloud/stackit/rabbitmq";
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
import { instanceApi, type RabbitMQApiContext, type RabbitMQApiError } from "./internal.ts";

/** A broker plugin STACKIT lets an instance enable. */
export type InstancePlugin =
  | "rabbitmq_consistent_hash_exchange"
  | "rabbitmq_federation"
  | "rabbitmq_federation_management"
  | "rabbitmq_mqtt"
  | "rabbitmq_sharding"
  | "rabbitmq_shovel"
  | "rabbitmq_shovel_management"
  | "rabbitmq_stomp"
  | "rabbitmq_event_exchange";

export interface InstanceProps {
  /**
   * Name of the instance. Changing it replaces the instance, and removing it keeps
   * the current name. STACKIT rejects a second instance with the same name in a
   * project and region.
   *
   * @default a unique name generated from the stack, stage and logical ID
   */
  name?: string;
  /**
   * RabbitMQ version, e.g. `4.1`. With `planName` it selects the plan; `listOfferings`
   * in the API lists what a project can use. Updates in place.
   */
  version: string;
  /**
   * Plan within `version`, e.g. `stackit-rabbitmq-2.4.10-single`. Updates in place.
   */
  planName: string;
  /**
   * IP ranges allowed to reach the instance, in CIDR notation. Clients outside them
   * can't connect, so this has to include every host using a binding on the broker
   * and the machine that deploys, if it talks to the broker. Updates in place.
   *
   * @default STACKIT's default ranges (left unmanaged)
   */
  acl?: string[];
  /**
   * Key encrypting the instance's backups. Updates in place, and only when it differs
   * from the last deploy's, because the API can't read it back. Removing it leaves the
   * key in place.
   */
  backupEncryptionKey?: string | Redacted.Redacted<string>;
  /**
   * Whether STACKIT applies platform updates by itself. Updates in place.
   *
   * @default the instance's current setting (left unmanaged)
   */
  automaticUpdates?: boolean;
  /**
   * Whether the instance reports to a monitoring instance. Updates in place.
   *
   * @default STACKIT's default (`false`)
   */
  enableMonitoring?: boolean;
  /** Id of the Observability instance that receives metrics. Updates in place. */
  monitoringInstanceId?: string;
  /** `host:port` of a Graphite endpoint for metrics. Updates in place. */
  graphite?: string;
  /**
   * Seconds between metrics. Updates in place.
   *
   * @default STACKIT's default (`10`)
   */
  metricsFrequency?: number;
  /** Prefix of emitted metrics, which some Graphite providers use as an API key. Updates in place. */
  metricsPrefix?: string | Redacted.Redacted<string>;
  /**
   * Disk usage in percent at which STACKIT stops the node's processes. Updates in place.
   *
   * @default STACKIT's default (`80`)
   */
  maxDiskThreshold?: number;
  /** `host:port` syslog drains. Updates in place. */
  syslog?: string[];
  /**
   * Broker plugins to enable. MQTT and STOMP clients need `rabbitmq_mqtt` and
   * `rabbitmq_stomp`. Updates in place.
   */
  plugins?: InstancePlugin[];
  /**
   * Milliseconds a consumer may hold a delivery unacknowledged. STACKIT's minimum is
   * `1800000`. Updates in place.
   *
   * @default STACKIT's default (`1800000`)
   */
  consumerTimeout?: number;
  /** Project that owns the instance. Changing it replaces the instance. @default the profile's project */
  projectId?: string;
  /** Region of the instance. Changing it replaces the instance. @default the profile's region */
  region?: string;
}

export interface InstanceAttributes {
  /** STACKIT instance id. Stable across updates. */
  instanceId: string;
  /** Project that owns the instance. */
  projectId: string;
  /** Region of the instance. */
  region: string;
  /** Name of the instance. */
  name: string;
  /** RabbitMQ version. */
  version: string;
  /** Plan id `version` and `planName` resolved to. */
  planId: string;
  /** Plan name. */
  planName: string;
  /** IP ranges allowed to reach the instance, as the API reports them. */
  acl: string[];
  /** The instance's parameters as the API reports them, without `metrics_prefix`. */
  parameters: Record<string, unknown>;
  /** Offering name. */
  offeringName: string;
  /** Logo of the offering. */
  imageUrl: string;
  /** Address of the instance's dashboard. */
  dashboardUrl: string;
  /** Cloud Foundry service instance id behind the instance. */
  cfGuid: string;
  /** Cloud Foundry space behind the instance. */
  cfSpaceGuid: string;
  /** Cloud Foundry organization behind the instance. */
  cfOrganizationGuid: string;
  /** State of the instance and its last operation; `active` after a deploy. */
  status: string | undefined;
  /** State of the service instance. */
  instanceStatus: string | undefined;
  /** The last operation on the instance. */
  lastOperation: { type: string; state: string; description: string };
  /** Whether automatic updates are on. `undefined` until `automaticUpdates` is set. */
  automaticUpdates: boolean | undefined;
}

export type Instance = Resource<
  "Stackit.RabbitMQ.Instance",
  InstanceProps,
  InstanceAttributes,
  never,
  Providers
>;

/**
 * A managed RabbitMQ broker on STACKIT. Clients connect with a
 * `Stackit.RabbitMQ.Credential`.
 *
 * Plan, version and parameters update in place. Project, region and name replace the
 * instance, and a replacement starts empty. Deploys wait until the instance reports
 * `active`, which STACKIT's SDK allows up to 45 minutes for.
 *
 * Parameters the props leave out stay as they are: removing a prop stops managing the
 * value and doesn't reset it. Queues, exchanges and bindings live in the broker, not
 * here. Declare them from a runtime with `Stackit.RabbitMQ.DeclareQueue` and friends.
 *
 * STACKIT's API has no labels here. Alchemy recognizes an instance by the id in its
 * state, or by a generated name, which holds this generation's id and so can only be
 * its own. An instance found under an explicit name without state is reported as
 * unowned and only taken over with `--adopt`, and `alchemy unsafe nuke` skips explicit
 * names. Names of the generated shape are listed for nuke, whoever chose them.
 *
 * Instances are billed per started hour by plan.
 *
 * ### Creating an Instance
 * **Example:** A single-node broker
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const broker = yield* Stackit.RabbitMQ.Instance("Broker", {
 *   version: "4.1",
 *   planName: "stackit-rabbitmq-2.4.10-single",
 *   acl: ["203.0.113.7/32"],
 * });
 * ```
 *
 * **Example:** A replicated broker with a chosen name
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const broker = yield* Stackit.RabbitMQ.Instance("Broker", {
 *   name: "orders-production",
 *   version: "4.1",
 *   planName: "stackit-rabbitmq-1.2.10-replica",
 *   acl: ["203.0.113.0/24"],
 *   automaticUpdates: true,
 * });
 * ```
 *
 * ### Configuring the Broker
 * **Example:** Plugins and a longer consumer timeout
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const broker = yield* Stackit.RabbitMQ.Instance("Broker", {
 *   version: "4.1",
 *   planName: "stackit-rabbitmq-2.4.10-single",
 *   acl: ["203.0.113.7/32"],
 *   plugins: ["rabbitmq_mqtt", "rabbitmq_shovel"],
 *   consumerTimeout: 3_600_000,
 * });
 * ```
 *
 * **Example:** Metrics to Graphite and logs to syslog
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Redacted from "effect/Redacted";
 *
 * const broker = yield* Stackit.RabbitMQ.Instance("Broker", {
 *   version: "4.1",
 *   planName: "stackit-rabbitmq-2.4.10-single",
 *   acl: ["203.0.113.7/32"],
 *   graphite: "metrics.example.com:2003",
 *   metricsFrequency: 30,
 *   metricsPrefix: Redacted.make("api-key"),
 *   syslog: ["logs.example.com:514"],
 * });
 * ```
 *
 * ### Encrypting Backups
 * **Example:** Set the backup encryption key
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Redacted from "effect/Redacted";
 *
 * const broker = yield* Stackit.RabbitMQ.Instance("Broker", {
 *   version: "4.1",
 *   planName: "stackit-rabbitmq-2.4.10-single",
 *   acl: ["203.0.113.7/32"],
 *   backupEncryptionKey: Redacted.make("a-long-random-key"),
 * });
 * ```
 *
 * ### Connecting Clients
 * **Example:** A credential for the broker
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const broker = yield* Stackit.RabbitMQ.Instance("Broker", {
 *   version: "4.1",
 *   planName: "stackit-rabbitmq-2.4.10-single",
 *   acl: ["203.0.113.7/32"],
 * });
 * const credential = yield* Stackit.RabbitMQ.Credential("App", {
 *   instanceId: broker.instanceId,
 * });
 * ```
 *
 * ### Replacement Cautions
 * **Example:** Changing the name creates a new, empty broker
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // The old instance and its queues are deleted. Credentials on it are replaced too.
 * const broker = yield* Stackit.RabbitMQ.Instance("Broker", {
 *   name: "orders-v2",
 *   version: "4.1",
 *   planName: "stackit-rabbitmq-2.4.10-single",
 * });
 * ```
 *
 * @resource
 * @product STACKIT RabbitMQ
 * @category RabbitMQ
 */
export const Instance = Resource<Instance>("Stackit.RabbitMQ.Instance");

const parametersOf = (props: InstanceProps): rabbitmq.InstanceParameters =>
  definedParameters({
    ...commonParameters(props),
    plugins: props.plugins,
    consumer_timeout: props.consumerTimeout,
  });

const lifecycle = makeInstanceLifecycle<
  RabbitMQApiError,
  RabbitMQApiContext,
  rabbitmq.InstanceParameters,
  InstanceProps,
  InstanceAttributes
>({
  label: "STACKIT RabbitMQ instance",
  api: instanceApi,
  parametersOf,
  attributes: (base) => base,
});

export const InstanceProvider = () =>
  Provider.succeed(Instance, {
    stables: ["instanceId", "projectId", "region", "name"],

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      return yield* lifecycle.list({ projectId: env.projectId, region: env.region });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      const identity = yield* lifecycle.diffIdentity(news, output);
      if (identity !== undefined) return identity;
      if (!isResolved(news)) return undefined;
      // Everything else updates in place (engine default: props changed).
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      return yield* lifecycle.read({ id, olds, output, previous });
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      return yield* lifecycle.reconcile({ id, news, olds, output });
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* lifecycle.delete(output);
    }),
  });
