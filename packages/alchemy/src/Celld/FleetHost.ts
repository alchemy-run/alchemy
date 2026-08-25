/**
 * The extension seam between the host-agnostic `Celld.*` resources and the
 * platform a fleet's nodes run on — the celld analog of
 * `Kubernetes.ClusterAdapter`.
 *
 * A {@link FleetHostService} is registered under a keyed Context tag —
 * `Celld.FleetHost/<kind>` — and resolved dynamically from the ambient
 * provider context by {@link findFleetHost}. Cloud provider layers
 * contribute theirs (`AWS.providers()` registers `aws-ecs`); the core
 * `Celld.providers()` ships none.
 *
 * A host owns everything platform-specific:
 *
 * - **compose** — plan-time composition of the fleet's child resources
 *   (S3-compatible bucket, network, node compute, auth secret), returning
 *   the connection material the core Fleet resource persists.
 * - **deployEnv** — the environment for the `celld deploy` child process
 *   (standard-chain object-store credentials — celld reads no profiles).
 * - **restartNodes** — roll the fleet's nodes after a deploy: celld nodes
 *   load a deployment at startup, so a new version requires a restart.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { Input } from "../Input.ts";
import type { FleetProps } from "./Fleet.ts";

/**
 * Host-specific options carried on `FleetProps.host`, keyed by host kind
 * and extended via module augmentation:
 *
 * ```ts
 * declare module "../Celld/FleetHost.ts" {
 *   interface FleetHostOptionsRegistry {
 *     "aws-ecs": {
 *       vpc?: { subnetIds: string[]; securityGroupIds: string[] };
 *     };
 *   }
 * }
 * ```
 */
export interface FleetHostOptionsRegistry {}

/** The discriminated `host` prop union across all registered hosts. */
export type FleetHostProps = keyof FleetHostOptionsRegistry extends never
  ? { kind?: string }
  : {
      [K in keyof FleetHostOptionsRegistry]: {
        readonly kind?: K;
      } & FleetHostOptionsRegistry[K];
    }[keyof FleetHostOptionsRegistry];

/**
 * The S3-compatible bucket backing a fleet, as `celld` consumes it.
 */
export interface FleetBucket {
  /** `s3://name` URI. */
  readonly uri: string;
  /** Optional S3-compatible endpoint (MinIO, R2, …). */
  readonly endpoint?: string;
  /** The bucket's region. */
  readonly region?: string;
}

export interface FleetHostComposeOptions {
  /** The Fleet's logical id. */
  readonly id: string;
  /** The user-supplied Fleet props. */
  readonly props: FleetProps;
}

/**
 * The connection material a host's `compose` hands back to the core Fleet.
 * Values may be `Output`s of the composed child resources (`Input` accepts
 * both).
 */
export interface FleetHostComposeResult {
  readonly bucket: {
    readonly uri: Input<string>;
    readonly endpoint?: Input<string>;
    readonly region?: Input<string>;
  };
  /** The HTTP endpoint VPC-attached callers reach the fleet's nodes on. */
  readonly fleetUrl: Input<string>;
  /** The fleet auth secret (checked by the gateway). */
  readonly fleetSecret: Input<Redacted.Redacted<string>>;
  /** Host-specific state persisted on the Fleet's props/attributes. */
  readonly hostState?: Record<string, Input<any>>;
}

/**
 * The fleet connection material a deployment (Worker) resource carries —
 * copied from the Fleet's attributes — as the host's `deployEnv` /
 * `restartNodes` operations receive it, resolved to plain values.
 */
export interface FleetConnection {
  readonly bucket?: FleetBucket;
  readonly hostKind?: string;
  readonly hostState?: Record<string, any>;
}

export interface FleetHostService {
  readonly kind: "Celld.FleetHost";
  readonly compose: (
    options: FleetHostComposeOptions,
  ) => Effect.Effect<FleetHostComposeResult, any, any>;
  readonly deployEnv: (options: {
    /** The deploying resource's resolved props (fleet connection included). */
    readonly news: FleetConnection;
  }) => Effect.Effect<Record<string, string>, any, any>;
  readonly restartNodes: (options: {
    /** The deploying resource's resolved props (fleet connection included). */
    readonly news: FleetConnection;
  }) => Effect.Effect<void, any, any>;
}

const FLEET_HOST_PREFIX = "Celld.FleetHost/";

/**
 * The keyed Context tag for a fleet host. Same kind → same tag, so a layer
 * built with `FleetHost("aws-ecs")` is found by any dynamic lookup for that
 * kind.
 */
/**
 * The tag identity for one registered FleetHost kind — 1:1 with the
 * constructor: `FleetHost<"aws-ecs">` is the type of the tag
 * `FleetHost("aws-ecs")` returns. The phantom pins the kind into the
 * identity so a layer registered for one kind cannot satisfy a
 * requirement for another; the service shape stays FleetHostService.
 */
export interface FleetHost<
  Kind extends string = string,
> extends FleetHostService {
  /** @internal phantom — never set at runtime. */
  readonly hostKind?: Kind;
}

export const FleetHost = <const Kind extends string>(
  kind: Kind,
): Context.Service<FleetHost<Kind>, FleetHostService> =>
  Context.Service<FleetHost<Kind>, FleetHostService>()(
    `${FLEET_HOST_PREFIX}${kind}`,
  );

const missingHost = (kind: string | undefined) =>
  Effect.die(
    new Error(
      kind === undefined
        ? "No Celld fleet host is registered. Add the provider layer that " +
            "contributes one to the stack's providers — e.g. 'aws-ecs' ships " +
            "with `AWS.providers()`: " +
            "`providers: Layer.mergeAll(AWS.providers(), Celld.providers())`."
        : `No Celld fleet host is registered for kind '${kind}'. Add the ` +
            "provider layer that contributes it to the stack's providers — " +
            "e.g. 'aws-ecs' ships with `AWS.providers()`: " +
            "`providers: Layer.mergeAll(AWS.providers(), Celld.providers())`.",
    ),
  );

/**
 * Resolve the {@link FleetHostService} (and its kind) from the ambient
 * context (the stack's composed provider layers). When `kind` is omitted,
 * resolves the SOLE registered host — ambiguity or absence dies with setup
 * guidance.
 */
export const resolveFleetHost = (
  kind?: string,
): Effect.Effect<{ kind: string; host: FleetHostService }> =>
  kind !== undefined
    ? Effect.serviceOption(FleetHost(kind)).pipe(
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
            typeof key === "string" && key.startsWith(FLEET_HOST_PREFIX),
        ) as string[];
      }).pipe(
        Effect.flatMap((kinds) => {
          if (kinds.length === 1) {
            return resolveFleetHost(kinds[0].slice(FLEET_HOST_PREFIX.length));
          }
          if (kinds.length === 0) {
            return missingHost(undefined);
          }
          return Effect.die(
            new Error(
              `Multiple Celld fleet hosts are registered (${kinds
                .map((k) => `'${k.slice(FLEET_HOST_PREFIX.length)}'`)
                .join(", ")}) — select one with the Fleet's ` +
                "`host: { kind: ... }` prop.",
            ),
          );
        }),
      );

/** Resolve the {@link FleetHostService} for a known host kind. */
export const findFleetHost = (kind?: string): Effect.Effect<FleetHostService> =>
  resolveFleetHost(kind).pipe(Effect.map(({ host }) => host));
