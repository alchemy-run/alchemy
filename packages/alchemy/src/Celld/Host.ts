import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { DnsRecordProps } from "../Dns.ts";
import type { Input } from "../Input.ts";
import type { Fleet, FleetProps } from "./Fleet.ts";

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

/**
 * The connection material a host's `compose` hands back to the core Fleet.
 * Values may be `Output`s of the composed child resources (`Input` accepts
 * both).
 */
export interface HostComposeResult {
  readonly bucket: {
    readonly uri: Input<string>;
    readonly endpoint?: Input<string>;
    readonly region?: Input<string>;
  };
  /** The HTTP endpoint network-attached callers reach the fleet's nodes on. */
  readonly fleetUrl: Input<string>;
  /** Host-specific state persisted on the Fleet's attributes. */
  readonly hostState?: Record<string, Input<any>>;
}

/**
 * The fleet connection material a `Celld.Worker` carries — copied from the
 * Fleet's attributes — as the host's `deployEnv` / `restartNodes`
 * operations receive it, resolved to plain values.
 */
export interface FleetConnection {
  readonly bucket?: FleetBucket;
  readonly hostState?: Record<string, any>;
}

/** What a host's `ingress` hands back. */
export interface HostIngressResult {
  /** The URL the exposed worker serves on (`https://{domain}` with a domain). */
  readonly url: Input<string>;
  /** DNS name of the composed load balancer — the `domain` CNAME's target. */
  readonly dnsName: Input<string>;
  /**
   * DNS records the certificate's issuance depends on (empty without a
   * domain), shaped for the `Alchemy.Dns` seam.
   */
  readonly validationRecords: readonly DnsRecordProps[];
}

export interface HostService {
  /**
   * Plan-time composition of the fleet's child resources (bucket, network,
   * node compute), returning the connection material the core Fleet
   * persists.
   */
  readonly compose: (options: {
    /** The Fleet's logical id. */
    readonly id: string;
    readonly props: FleetProps;
  }) => Effect.Effect<HostComposeResult, any, any>;
  /**
   * Compose public ingress (load balancer, security group, certificate) in
   * front of a composed fleet's nodes. Called from a Worker's props
   * transform AFTER the fleet resolved, so the host reads the fleet's
   * attribute Outputs. Pure plan-time composition — resources only.
   */
  readonly ingress: (options: {
    /** The exposing Worker's logical id. */
    readonly id: string;
    /** The composed fleet (attribute Outputs). */
    readonly fleet: Fleet;
    /** Custom domain — requests a matching TLS certificate. */
    readonly domain?: string | undefined;
  }) => Effect.Effect<HostIngressResult, any, any>;
  /**
   * The environment for the `celld deploy` child process: standard-chain
   * object-store credentials (celld reads no profiles or SSO caches).
   */
  readonly deployEnv: (options: {
    readonly news: FleetConnection;
  }) => Effect.Effect<Record<string, string>, any, any>;
  /**
   * Roll the fleet's nodes after a deploy: celld nodes load a deployment at
   * startup, so a new version requires a restart.
   */
  readonly restartNodes: (options: {
    readonly news: FleetConnection;
  }) => Effect.Effect<void, any, any>;
}

/**
 * The platform a fleet's nodes run on — the celld analog of
 * `Kubernetes.ClusterAdapter`. `Celld.Fleet` yields this service to
 * compose its infrastructure; provide an implementation Layer alongside
 * the providers (`Celld.Ecs()` for AWS ECS Fargate).
 */
export class Host extends Context.Service<Host, HostService>()("Celld.Host") {}
