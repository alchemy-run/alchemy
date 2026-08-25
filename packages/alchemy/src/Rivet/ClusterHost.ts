/**
 * The extension seam between the host-agnostic `Rivet.*` resources and the
 * platform the Rivet **engine** (the orchestrator) runs on — the Rivet
 * analog of `Celld.FleetHost` / `Kubernetes.ClusterAdapter`.
 *
 * A {@link ClusterHostService} is registered under a keyed Context tag —
 * `Rivet.ClusterHost/<kind>` — and resolved dynamically from the ambient
 * provider context by {@link findClusterHost}. Cloud provider layers
 * contribute theirs (`AWS.providers()` registers `aws-ecs`); the core
 * `Rivet.providers()` ships none.
 *
 * A host owns everything platform-specific:
 *
 * - **compose** — plan-time composition of the engine's child resources
 *   (network, compute, discovery, admin token), returning the connection
 *   material the core Cluster resource persists.
 * - **restartNodes** — roll the engine's nodes (e.g. after a config change
 *   that only takes effect at process start).
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { Input } from "../Input.ts";

/**
 * Host-specific options carried on the Cluster's `host` prop, keyed by host
 * kind and extended via module augmentation:
 *
 * ```ts
 * declare module "../Rivet/ClusterHost.ts" {
 *   interface ClusterHostOptionsRegistry {
 *     "aws-ecs": {
 *       vpc?: { vpcId: string; subnetIds: string[]; securityGroupIds: string[] };
 *     };
 *   }
 * }
 * ```
 */
export interface ClusterHostOptionsRegistry {}

/** The discriminated `host` prop union across all registered hosts. */
export type ClusterHostProps = keyof ClusterHostOptionsRegistry extends never
  ? { kind?: string }
  : {
      [K in keyof ClusterHostOptionsRegistry]: {
        readonly kind?: K;
      } & ClusterHostOptionsRegistry[K];
    }[keyof ClusterHostOptionsRegistry];

/**
 * The subset of the core Cluster's props a host reads during `compose`.
 * The core `Rivet.Cluster` resource's own Props satisfy this structurally.
 */
export interface ClusterHostComposeProps {
  /** Host selection + host-specific options. */
  readonly host?: ClusterHostProps;
  /**
   * Rivet engine version — the tag of the `rivetdev/engine` image the host
   * runs.
   */
  readonly rivetVersion?: string;
  /**
   * Full engine image override (escape hatch past {@link rivetVersion}, e.g.
   * a mirrored registry or a digest pin).
   */
  readonly image?: string;
  /**
   * Number of engine nodes. Only meaningful with a multi-node storage
   * backend — the built-in RocksDB backend is single-node.
   * @default 1
   */
  readonly instances?: number;
  /** Tags applied to every resource the host composes. */
  readonly tags?: Record<string, string>;
}

export interface ClusterHostComposeOptions {
  /** The Cluster's logical id. */
  readonly id: string;
  /** The user-supplied Cluster props. */
  readonly props: ClusterHostComposeProps;
}

/**
 * The connection material a host's `compose` hands back to the core Cluster.
 * Values may be `Output`s of the composed child resources (`Input` accepts
 * both).
 */
export interface ClusterHostComposeResult {
  /** The HTTP endpoint callers reach the engine's guard service on. */
  readonly endpoint: Input<string>;
  /** The engine's admin token (`RIVET__AUTH__ADMIN_TOKEN`). */
  readonly adminToken: Input<Redacted.Redacted<string>>;
  /**
   * Network attachment for callers that must run inside the engine's VPC,
   * surfaced separately from {@link hostState} so caller hosts can consume
   * it without knowing the host kind.
   */
  readonly vpc?: {
    readonly subnetIds: Input<string[]>;
    readonly securityGroupIds: Input<string[]>;
  };
  /** Host-specific state persisted on the Cluster's props/attributes. */
  readonly hostState?: Record<string, Input<any>>;
}

/**
 * The engine connection material a dependent resource carries — copied from
 * the Cluster's attributes — as the host's `restartNodes` operation receives
 * it, resolved to plain values.
 */
export interface ClusterConnection {
  readonly hostKind?: string;
  readonly hostState?: Record<string, any>;
}

export interface ClusterHostService {
  readonly kind: "Rivet.ClusterHost";
  readonly compose: (
    options: ClusterHostComposeOptions,
  ) => Effect.Effect<ClusterHostComposeResult, any, any>;
  readonly restartNodes: (options: {
    /** The deploying resource's resolved props (engine connection included). */
    readonly news: ClusterConnection;
  }) => Effect.Effect<void, any, any>;
}

const CLUSTER_HOST_PREFIX = "Rivet.ClusterHost/";

/**
 * The keyed Context tag for a Rivet cluster host. Same kind → same tag, so a
 * layer built with `ClusterHost("aws-ecs")` is found by any dynamic lookup
 * for that kind.
 */
/**
 * The tag identity for one registered ClusterHost kind — 1:1 with the
 * constructor: `ClusterHost<"aws-ecs">` is the type of the tag
 * `ClusterHost("aws-ecs")` returns. The phantom pins the kind into the
 * identity so a layer registered for one kind cannot satisfy a
 * requirement for another; the service shape stays ClusterHostService.
 */
export interface ClusterHost<
  Kind extends string = string,
> extends ClusterHostService {
  /** @internal phantom — never set at runtime. */
  readonly hostKind?: Kind;
}

export const ClusterHost = <const Kind extends string>(
  kind: Kind,
): Context.Service<ClusterHost<Kind>, ClusterHostService> =>
  Context.Service<ClusterHost<Kind>, ClusterHostService>()(
    `${CLUSTER_HOST_PREFIX}${kind}`,
  );

const missingHost = (kind: string | undefined) =>
  Effect.die(
    new Error(
      kind === undefined
        ? "No Rivet cluster host is registered. Add the provider layer that " +
            "contributes one to the stack's providers — e.g. 'aws-ecs' ships " +
            "with `AWS.providers()`: " +
            "`providers: Layer.mergeAll(AWS.providers(), Rivet.providers())`."
        : `No Rivet cluster host is registered for kind '${kind}'. Add the ` +
            "provider layer that contributes it to the stack's providers — " +
            "e.g. 'aws-ecs' ships with `AWS.providers()`: " +
            "`providers: Layer.mergeAll(AWS.providers(), Rivet.providers())`.",
    ),
  );

/**
 * Resolve the {@link ClusterHostService} (and its kind) from the ambient
 * context (the stack's composed provider layers). When `kind` is omitted,
 * resolves the SOLE registered host — ambiguity or absence dies with setup
 * guidance.
 */
export const resolveClusterHost = (
  kind?: string,
): Effect.Effect<{ kind: string; host: ClusterHostService }> =>
  kind !== undefined
    ? Effect.serviceOption(ClusterHost(kind)).pipe(
        Effect.flatMap((option) =>
          option._tag === "Some"
            ? Effect.succeed({ kind, host: option.value })
            : missingHost(kind),
        ),
      )
    : Effect.gen(function* () {
        const context = yield* Effect.context<never>();
        return [...(context as any).mapUnsafe.keys()].filter(
          (key: unknown): key is string =>
            typeof key === "string" && key.startsWith(CLUSTER_HOST_PREFIX),
        ) as string[];
      }).pipe(
        Effect.flatMap((kinds) => {
          if (kinds.length === 1) {
            return resolveClusterHost(
              kinds[0].slice(CLUSTER_HOST_PREFIX.length),
            );
          }
          if (kinds.length === 0) {
            return missingHost(undefined);
          }
          return Effect.die(
            new Error(
              `Multiple Rivet cluster hosts are registered (${kinds
                .map((k) => `'${k.slice(CLUSTER_HOST_PREFIX.length)}'`)
                .join(", ")}) — select one with the Cluster's ` +
                "`host: { kind: ... }` prop.",
            ),
          );
        }),
      );

/** Resolve the {@link ClusterHostService} for a known host kind. */
export const findClusterHost = (
  kind?: string,
): Effect.Effect<ClusterHostService> =>
  resolveClusterHost(kind).pipe(Effect.map(({ host }) => host));
