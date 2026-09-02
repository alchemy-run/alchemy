import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { InputProps } from "../Input.ts";
import type { Named, Tag } from "../Named.ts";
import { Platform, type PlatformProps } from "../Platform.ts";
import * as Provider from "../Provider.ts";
import { Resource, isResourceOfType } from "../Resource.ts";
import type { BaseRuntimeContext } from "../RuntimeContext.ts";
import { Host, type FleetBucket } from "./Host.ts";
import type { Providers } from "./Providers.ts";

export const FleetTypeId = "Celld.Fleet";
export type FleetTypeId = typeof FleetTypeId;

export interface FleetProps extends PlatformProps {
  /**
   * Number of fleet nodes — a fixed count, or an autoscaling range. The
   * object form composes a CPU target-tracking policy on the node compute
   * (`targetCpu` percent, default 60); the plain number pins a fixed count.
   * @default 2
   */
  instances?:
    | number
    | {
        /** Minimum node count the host may scale in to. */
        min: number;
        /** Maximum node count the host may scale out to. */
        max: number;
        /** Target average CPU utilization (percent). @default 60 */
        targetCpu?: number;
      };
  /**
   * Container image the fleet's nodes run.
   * @default the pinned celld image digest
   */
  image?: string;
  /**
   * CPU units per node, as the host's compute platform counts them
   * (Fargate: 256, 512, 1024, …).
   * @default 512
   */
  cpu?: number;
  /**
   * Memory per node (MiB).
   * @default 1024
   */
  memory?: number;
  /**
   * CPU architecture of the node compute. The default celld image is
   * multi-arch; pick the architecture the host's compute offers cheapest.
   * @default "ARM64"
   */
  cpuArchitecture?: "ARM64" | "X86_64";
  /**
   * Bring your own network: the VPC and subnets the fleet nodes run in,
   * plus the security group(s) admitting fleet traffic on port 8080. When
   * omitted the host composes a dedicated network. Public ingress
   * (`Celld.Worker`'s `expose`) needs public subnets in at least two
   * Availability Zones.
   */
  vpc?: {
    vpcId: string;
    subnetIds: string[];
    securityGroupIds: string[];
  };
  /** Tags applied to host-composed cloud resources. */
  tags?: Record<string, string>;
  /** Written by the host's `compose` — never set manually. @internal */
  bucket?: FleetBucket;
  /** Written by the host's `compose` — never set manually. @internal */
  fleetUrl?: string;
  /** Written by the host's `compose` — never set manually. @internal */
  hostState?: Record<string, any>;
}

export interface Fleet extends Resource<
  FleetTypeId,
  FleetProps,
  {
    /** The HTTP endpoint network-attached callers reach the fleet on. */
    fleetUrl: string;
    /** The S3-compatible bucket backing the fleet. */
    bucket: FleetBucket;
    /** Host-specific state (compute identifiers, network attachment). */
    hostState: Record<string, any> | undefined;
  },
  {},
  Providers
> {}

export const isFleet = <T>(value: T): value is T & Fleet =>
  isResourceOfType(value, FleetTypeId);

/** No `Celld.Host` Layer is in the stack's providers. */
export class HostNotProvided extends Data.TaggedError("Celld.HostNotProvided")<{
  readonly message: string;
}> {}

/** Resolve the ambient {@link Host}, failing with setup guidance when absent. */
export const requireHost = (
  id: string,
): Effect.Effect<Host["Service"], HostNotProvided> =>
  Effect.serviceOption(Host).pipe(
    Effect.flatMap(
      Option.match({
        onSome: Effect.succeed,
        onNone: () =>
          Effect.fail(
            new HostNotProvided({
              message:
                `Celld.Fleet '${id}' has no host — provide one alongside the ` +
                "providers, e.g. " +
                "`Layer.mergeAll(AWS.providers(), Celld.providers(), Celld.Ecs())`.",
            }),
          ),
      }),
    ),
  );

/**
 * Compose the fleet's platform-specific children (bucket, network, node
 * compute) through the ambient {@link Host} and rewrite the props with the
 * connection material. A no-op at runtime.
 */
const transformFleetProps = (
  id: string,
  props: FleetProps,
): Effect.Effect<FleetProps, HostNotProvided, any> =>
  Effect.gen(function* () {
    // Composition is a plan/deploy concern — never runs inside bundles.
    if (globalThis.__ALCHEMY_RUNTIME__) {
      return props;
    }
    const host = yield* requireHost(id);
    const composed = yield* host.compose({ id, props });
    return {
      ...props,
      bucket: composed.bucket,
      fleetUrl: composed.fleetUrl,
      hostState: composed.hostState,
    } as FleetProps;
  });

/** A fleet carries no code — there is nothing to serve at init. */
const makeFleetContext = (id: string): BaseRuntimeContext => ({
  Type: FleetTypeId,
  id,
  env: {},
  get: () => Effect.succeed(undefined),
  set: (key) => Effect.succeed(key),
});

/**
 * A fleet takes no impl (it carries no code), so its class surface adds the
 * tag + props forms the generic `Platform` type lacks.
 */
export type FleetClass = {
  <Self>(): {
    <const Id extends string>(
      id: Id,
      props?: InputProps<FleetProps>,
    ): Effect.Effect<Fleet, never, Providers> &
      Named<Id> & {
        new (_: never): Named<Id> & Tag<FleetTypeId>;
      };
  };
  (
    id: string,
    props?: InputProps<FleetProps>,
  ): Effect.Effect<Fleet, never, Providers>;
} & Platform<Fleet, never, void, BaseRuntimeContext>;

/**
 * A **Celld fleet**: the infrastructure a `Celld.Worker` runs on. Fleet
 * nodes embed V8 and coordinate through an S3-compatible bucket
 * ([celld](https://github.com/denoland/celld)); cells (Durable Object
 * instances) replicate their SQLite state to the bucket before
 * acknowledging writes.
 *
 * The fleet is platform-agnostic: WHERE the nodes run (and which bucket
 * backs them) is owned by the `Celld.Host` Layer composed alongside the
 * providers — `Celld.Ecs()` runs them as an ECS Fargate service. The fleet
 * carries no code; deploy a `Celld.Worker` onto it.
 *
 * ### Creating a Fleet
 * **Example:** A two-node fleet on ECS Fargate
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as AWS from "alchemy/AWS";
 * import * as Celld from "alchemy/Celld";
 * import * as Layer from "effect/Layer";
 *
 * export class Cells extends Celld.Fleet<Cells>()("Cells", {
 *   instances: 2,
 * }) {}
 *
 * const stack = Alchemy.Stack("app", {
 *   providers: Layer.mergeAll(AWS.providers(), Celld.providers(), Celld.Ecs()),
 *   state: AWS.state(),
 * });
 * ```
 *
 * ### Sizing the Nodes
 * **Example:** Autoscaling range on larger tasks
 * ```typescript
 * export class Cells extends Celld.Fleet<Cells>()("Cells", {
 *   instances: { min: 2, max: 6, targetCpu: 60 },
 *   cpu: 1024,
 *   memory: 2048,
 *   cpuArchitecture: "X86_64",
 * }) {}
 * ```
 *
 * ### Bringing Your Own Network
 * **Example:** Nodes in an existing VPC
 * ```typescript
 * export class Cells extends Celld.Fleet<Cells>()("Cells", {
 *   vpc: {
 *     vpcId: network.vpcId,
 *     subnetIds: network.publicSubnetIds,
 *     securityGroupIds: [fleetSecurityGroup.groupId],
 *   },
 * }) {}
 * ```
 *
 * @resource
 * @product Celld
 */
export const Fleet: FleetClass = Platform(FleetTypeId, {
  createRuntimeContext: makeFleetContext,
  transformProps: transformFleetProps,
}) as FleetClass;

/** The fleet's connection material was never composed (no host ran). */
export class FleetNotComposed extends Data.TaggedError(
  "Celld.FleetNotComposed",
)<{
  readonly message: string;
}> {}

export const FleetProvider = () =>
  Provider.succeed(Fleet, {
    // The connection material never changes across an update (the Cloud
    // Map name, the bucket, the compute identifiers) — only a replacement
    // mints new ones — so consumers' diffs see resolved values.
    stables: ["bucket", "fleetUrl", "hostState"],

    read: ({ output }) => Effect.succeed(output),

    // The fleet's physical substance lives in the host-composed children —
    // this resource just persists the connection material they produced.
    reconcile: ({ id, news }) =>
      Effect.gen(function* () {
        if (news.bucket === undefined || news.fleetUrl === undefined) {
          return yield* Effect.fail(
            new FleetNotComposed({
              message: `Celld.Fleet '${id}' has no composed host state — is a Celld.Host Layer in the stack's providers?`,
            }),
          );
        }
        return {
          fleetUrl: news.fleetUrl,
          bucket: news.bucket,
          hostState: news.hostState,
        };
      }),

    delete: () => Effect.void,
  });
