import * as DO from "@distilled.cloud/digitalocean";
import type {
  AutoscalePool as ApiAutoscalePool,
  AutoscalePoolDropletTemplateRegion,
} from "@distilled.cloud/digitalocean";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ignoreNotFound, noneIfNotFound } from "./internal/notFound.ts";
import { pollUntil, type PollBudget } from "./internal/poll.ts";
import type { Providers } from "./Providers.ts";

export type AutoscalePoolScaling =
  | {
      /** Keep exactly this many droplets. */
      readonly instances: number;
    }
  | {
      /** Fewest droplets. */
      readonly minInstances: number;
      /** Most droplets. */
      readonly maxInstances: number;
      /** Average CPU utilization (0 to 1) to scale toward. */
      readonly targetCpuUtilization?: number;
      /** Average memory utilization (0 to 1) to scale toward. */
      readonly targetMemoryUtilization?: number;
      /** Minutes to wait between scaling actions. */
      readonly cooldownMinutes?: number;
    };

export type AutoscalePoolProps = {
  /**
   * Pool name. A change renames the pool in place.
   *
   * @default a generated physical name
   */
  name?: string;
  /** How many droplets to run. Updates in place. */
  scaling: AutoscalePoolScaling;
  /** The droplets the pool runs. A change rolls the pool onto the new template. */
  droplet: {
    readonly region: AutoscalePoolDropletTemplateRegion;
    readonly size: string;
    readonly image: string;
    /** SSH key ids or fingerprints; at least one. */
    readonly sshKeys: string[];
    readonly tags?: string[];
    readonly vpcUuid?: string;
    readonly userData?: string;
    readonly ipv6?: boolean;
  };
};

export type AutoscalePool = Resource<
  "DigitalOcean.AutoscalePool",
  AutoscalePoolProps,
  {
    /** Pool id (UUID). */
    autoscalePoolId: string;
    /** Pool name. */
    name: string;
    /** `active` once the pool runs its droplets. */
    status: string;
    /** Droplets the pool runs right now. */
    activeDroplets: number;
  },
  never,
  Providers
>;

export type AutoscalePoolAttributes = AutoscalePool["Attributes"];

/**
 * A DigitalOcean Droplet autoscale pool: a fleet of identical droplets kept
 * at a fixed count or scaled by CPU or memory utilization. Put a load
 * balancer in front by targeting the pool's droplet tag. Every prop updates
 * in place.
 *
 * ### Scaling Droplets
 * **Example:** Two to ten web droplets around 60% CPU
 * ```typescript
 * const key = yield* DigitalOcean.SshKey("deploy", { publicKey: yield* Config.string("SSH_KEY") });
 * const pool = yield* DigitalOcean.AutoscalePool("web", {
 *   scaling: { minInstances: 2, maxInstances: 10, targetCpuUtilization: 0.6 },
 *   droplet: {
 *     region: "nyc3",
 *     size: "s-1vcpu-1gb",
 *     image: "ubuntu-24-04-x64",
 *     sshKeys: [key.fingerprint],
 *     tags: ["web"],
 *     userData: "#cloud-config\npackages: [nginx]",
 *   },
 * });
 * yield* DigitalOcean.LoadBalancer("web-lb", {
 *   region: "nyc3",
 *   forwardingRules: [{ entryProtocol: "http", entryPort: 80, targetProtocol: "http", targetPort: 80 }],
 *   tag: "web",
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/Droplet-Autoscale-Pools
 *
 * @resource
 * @product Droplets
 * @category Compute
 */
export const AutoscalePool = Resource<AutoscalePool>("DigitalOcean.AutoscalePool");

export class AutoscalePoolWaitTimedOut extends Data.TaggedError(
  "DigitalOcean.AutoscalePoolWaitTimedOut",
)<{
  readonly autoscalePoolId: string;
  readonly waitingFor: string;
}> {
  override get message() {
    return `Autoscale pool ${this.autoscalePoolId} timed out waiting for ${this.waitingFor}.`;
  }
}

// Droplets take a minute or two to boot (≈ 10 min budget).
const POOL_POLL: PollBudget = { maxDelay: "10 seconds", times: 64 };

const physicalName = (id: string) => createPhysicalName({ id, lowercase: true, maxLength: 63 });

const toAttrs = (pool: ApiAutoscalePool): AutoscalePoolAttributes => ({
  autoscalePoolId: pool.id,
  name: pool.name,
  status: pool.status,
  activeDroplets: pool.active_resources_count,
});

const configOf = (scaling: AutoscalePoolScaling) =>
  "instances" in scaling
    ? { target_number_instances: scaling.instances }
    : {
        min_instances: scaling.minInstances,
        max_instances: scaling.maxInstances,
        target_cpu_utilization: scaling.targetCpuUtilization,
        target_memory_utilization: scaling.targetMemoryUtilization,
        cooldown_minutes: scaling.cooldownMinutes,
      };

const templateOf = (droplet: AutoscalePoolProps["droplet"]) => ({
  region: droplet.region,
  size: droplet.size,
  image: droplet.image,
  ssh_keys: droplet.sshKeys,
  tags: droplet.tags,
  vpc_uuid: droplet.vpcUuid,
  user_data: droplet.userData,
  ipv6: droplet.ipv6,
});

const observeById = (autoscalePoolId: string) =>
  noneIfNotFound(
    DO.getAutoscalepool({ autoscale_pool_id: autoscalePoolId }).pipe(
      Effect.map((r) => r.autoscale_pool),
    ),
  );

const observeByName = (name: string) =>
  DO.listAutoscalepools.items({ per_page: 200, name }).pipe(
    Stream.filter((pool) => pool.name === name),
    Stream.runHead,
  );

export const AutoscalePoolProvider = () =>
  Provider.succeed(AutoscalePool, {
    stables: ["autoscalePoolId"],
    nuke: { skip: true },
    read: Effect.fn(function* ({ id, olds, output }) {
      if (output !== undefined) {
        const byId = yield* observeById(output.autoscalePoolId);
        if (Option.isSome(byId)) return toAttrs(byId.value);
      }
      if (olds.name !== undefined) return undefined;
      const generatedName = yield* physicalName(id);
      const named = yield* observeByName(generatedName);
      return Option.getOrUndefined(Option.map(named, toAttrs));
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name = news.name ?? (yield* physicalName(id));
      const body = {
        name,
        config: configOf(news.scaling),
        droplet_template: templateOf(news.droplet),
      };
      const byId =
        output === undefined ? Option.none() : yield* observeById(output.autoscalePoolId);
      const observed = Option.isSome(byId)
        ? byId
        : news.name === undefined
          ? yield* observeByName(name)
          : Option.none<ApiAutoscalePool>();
      const pool = yield* Option.match(observed, {
        onNone: () => DO.createAutoscalepool(body).pipe(Effect.map((r) => r.autoscale_pool)),
        onSome: (existing) =>
          DO.updateAutoscalepool({ autoscale_pool_id: existing.id, ...body }).pipe(
            Effect.map((r) => r.autoscale_pool),
          ),
      });
      const active = yield* pollUntil(observeById(pool.id), {
        ...POOL_POLL,
        until: (o): o is Option.Some<ApiAutoscalePool> =>
          Option.isSome(o) && o.value.status === "active" && o.value.name === name,
        onTimeout: () =>
          new AutoscalePoolWaitTimedOut({
            autoscalePoolId: pool.id,
            waitingFor: "the active state",
          }),
      });
      return toAttrs(active.value);
    }),
    delete: Effect.fn(function* ({ output }) {
      // Deleting the pool destroys its droplets.
      yield* ignoreNotFound(DO.deleteAutoscalepool({ autoscale_pool_id: output.autoscalePoolId }));
      yield* pollUntil(observeById(output.autoscalePoolId), {
        ...POOL_POLL,
        until: Option.isNone,
        onTimeout: () =>
          new AutoscalePoolWaitTimedOut({
            autoscalePoolId: output.autoscalePoolId,
            waitingFor: "deletion",
          }),
      });
    }),
  });
