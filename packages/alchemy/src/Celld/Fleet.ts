/**
 * A **Celld fleet**: the infrastructure a {@link Worker} runs on. Fleet
 * nodes embed V8 and coordinate through an S3-compatible bucket
 * ([celld](https://github.com/denoland/celld)); cells (Durable Object
 * instances) replicate their SQLite state to the bucket before
 * acknowledging writes.
 *
 * The fleet is host-agnostic: WHERE the nodes run (and which bucket backs
 * them) is owned by a pluggable {@link FleetHost} contributed by a cloud
 * provider layer — `AWS.providers()` registers the `aws-ecs` host. The
 * fleet carries no code; deploy a {@link Worker} onto it.
 *
 * ### Creating a Fleet
 * **Example:** Example
 * ```typescript
 * export class Cells extends Celld.Fleet<Cells>()("Cells", {
 *   instances: 2,
 * }) {}
 * ```
 */
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { InputProps } from "../Input.ts";
import type { Named, Tag } from "../Named.ts";
import { Platform, type PlatformProps } from "../Platform.ts";
import * as Provider from "../Provider.ts";
import { Resource, isResourceOfType } from "../Resource.ts";
import type { BaseRuntimeContext } from "../RuntimeContext.ts";
import {
  resolveFleetHost,
  type FleetBucket,
  type FleetHostProps,
} from "./FleetHost.ts";
import { FleetTypeId } from "./FleetTypes.ts";
import type { Providers } from "./Providers.ts";

export interface FleetProps extends PlatformProps {
  /**
   * Which registered {@link FleetHost} runs the fleet's nodes, plus its
   * host-specific options. When omitted, the sole registered host is used.
   */
  host?: FleetHostProps;
  /**
   * Number of fleet nodes.
   * @default 2
   */
  instances?: number;
  /**
   * The celld release the default node image is pinned to.
   * @default DEFAULT_CELLD_VERSION
   */
  celldVersion?: string;
  /**
   * Container image the fleet's nodes run.
   * @default the pinned celld image digest
   */
  image?: string;
  /** Tags applied to host-composed cloud resources. */
  tags?: Record<string, string>;
  /** Written by the fleet host's `compose` — never set manually. @internal */
  hostKind?: string;
  /** Written by the fleet host's `compose` — never set manually. @internal */
  bucket?: FleetBucket;
  /** Written by the fleet host's `compose` — never set manually. @internal */
  fleetUrl?: string;
  /** Written by the fleet host's `compose` — never set manually. @internal */
  fleetSecret?: Redacted.Redacted<string>;
  /** Written by the fleet host's `compose` — never set manually. @internal */
  hostState?: Record<string, any>;
}

export interface Fleet extends Resource<
  FleetTypeId,
  FleetProps,
  {
    /** The HTTP endpoint VPC-attached callers reach the fleet on. */
    fleetUrl: string;
    /** The fleet auth secret checked by the Worker's RPC gateway. */
    fleetSecret: Redacted.Redacted<string>;
    /** The S3-compatible bucket backing the fleet. */
    bucket: FleetBucket;
    /** The {@link FleetHost} kind running the nodes. */
    hostKind: string;
    /** Host-specific state (compute identifiers, network attachment). */
    hostState: Record<string, any> | undefined;
  },
  {},
  Providers
> {}

export const isFleet = <T>(value: T): value is T & Fleet =>
  isResourceOfType(value, FleetTypeId);

/**
 * Compose the fleet's platform-specific children (bucket, network, node
 * compute, secret) through the registered {@link FleetHost} and rewrite the
 * props with the connection material. A no-op at runtime.
 */
const transformFleetProps = (
  id: string,
  props: FleetProps,
): Effect.Effect<FleetProps, unknown, any> =>
  Effect.gen(function* () {
    // Composition is a plan/deploy concern — never runs inside bundles.
    if (globalThis.__ALCHEMY_RUNTIME__) {
      return props;
    }
    const { kind, host } = yield* resolveFleetHost(props.host?.kind);
    const composed = yield* host.compose({ id, props });
    return {
      ...props,
      hostKind: kind,
      bucket: composed.bucket,
      fleetUrl: composed.fleetUrl,
      fleetSecret: composed.fleetSecret,
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

export const Fleet: FleetClass = Platform(FleetTypeId, {
  createRuntimeContext: makeFleetContext,
  transformProps: transformFleetProps,
}) as FleetClass;

export const FleetProvider = () =>
  Provider.succeed(Fleet, {
    stables: ["bucket", "hostKind"],

    read: ({ output }) => Effect.succeed(output),

    // The fleet's physical substance lives in the host-composed children —
    // this resource just persists the connection material they produced.
    reconcile: ({ id, news }) =>
      Effect.gen(function* () {
        if (
          news.bucket === undefined ||
          news.fleetUrl === undefined ||
          news.fleetSecret === undefined ||
          news.hostKind === undefined
        ) {
          return yield* Effect.die(
            new Error(
              `Celld.Fleet '${id}' has no composed host state — is a fleet host registered in the stack's providers?`,
            ),
          );
        }
        return {
          fleetUrl: news.fleetUrl,
          fleetSecret: news.fleetSecret,
          bucket: news.bucket,
          hostKind: news.hostKind,
          hostState: news.hostState,
        };
      }),

    delete: () => Effect.void,
  });
