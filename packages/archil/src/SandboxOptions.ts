import type * as archil from "@distilled.cloud/archil";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { Disk } from "./Disk.ts";
import type { Providers } from "./Providers.ts";

/**
 * An allowed destination, with optional changes to outbound HTTPS requests
 * that match it. Headers set here overwrite whatever the sandbox sends, so
 * a credential injected at the boundary never enters the sandbox.
 */
export interface SandboxEgressTarget {
  /** IPv4 address, CIDR range, exact domain, or `*.`-wildcard domain. */
  target: string;
  /** HTTP headers to set on matching HTTPS requests. */
  headers?: Record<string, string | Redacted.Redacted<string>>;
  /**
   * Forward matching requests to this public HTTPS URL instead of their
   * destination, such as a Worker that adds a credential. Archil appends
   * the original path and query, applies `headers` first, and names the
   * destination and the sandbox in `archil-forwarded-host`,
   * `archil-forwarded-scheme`, `archil-forwarded-port`,
   * `archil-forwarded-path` and `archil-sandbox-id` headers.
   */
  forwardUrl?: string;
}

/**
 * Outbound network policy. Deny entries win when an address or domain
 * matches both lists. Wildcards match subdomains, not the apex domain.
 */
export interface SandboxEgress {
  /** What happens to destinations neither list names. */
  default: "allow" | "deny";
  /** Allowed destinations: addresses, CIDRs, domains, or targets with request changes. */
  allow?: ReadonlyArray<string | SandboxEgressTarget>;
  /** Denied addresses, CIDRs, or domains. */
  deny?: ReadonlyArray<string>;
  /**
   * Hosts whose in-flight HTTP(S) requests finish before the sandbox
   * pauses (ports 80 and 443 only). Doesn't grant access.
   */
  drainOnPause?: ReadonlyArray<string>;
}

/**
 * How a mount shares the disk with other clients.
 *
 * - `exclusive` — this client owns writes to the whole disk (local-disk
 *   speed); other clients can still mount `read-only`.
 * - `shared` — many clients; the disk is read-only until a path is checked
 *   out with `archil checkout <path>`. FUSE client only.
 * - `conditional` — many writers; writes go to the server unless a path is
 *   checked out (remote-filesystem speed).
 * - `read-only` — no writes.
 */
export type MountMode = "exclusive" | "shared" | "conditional" | "read-only";

/** A disk known at run time, e.g. a `DiskHandle` from `CreateDisk`. */
export interface DiskRef {
  readonly diskId: string;
}

/**
 * The disk of a mount entry: a declared `Archil.Disk` (or the Effect that
 * declares it), or a run-time handle with its `diskId`.
 */
export type MountableDisk = Disk | Effect.Effect<Disk, never, Providers> | DiskRef;

/** How a disk is mounted, in Archil's own terms. */
export interface DiskMountOptions {
  /** Absolute directory to mount at. */
  readonly path: string;
  /** @default "exclusive" */
  readonly mode?: MountMode;
  /** Mount only this subdirectory of the disk. */
  readonly subdirectory?: string;
  /**
   * Milliseconds to wait for the disk's exclusive root delegation before
   * the mount fails. Only for `exclusive` mounts in an `Archil.Sandbox`.
   */
  readonly queueMs?: number;
  /** Mount a branch of the disk instead of its root. FUSE client only. */
  readonly branch?: string;
  /**
   * Take ownership of the root from a client that crashed without
   * unmounting; that client's outstanding writes are lost. FUSE client only.
   */
  readonly force?: boolean;
}

/** A disk mounted into a sandbox (`mounts`), or by `MountDisk`. */
export interface DiskMount extends DiskMountOptions {
  readonly disk: MountableDisk;
}

/** A mount option the target doesn't support was set. */
export class MountOptionUnsupported extends Data.TaggedError("Archil.MountOptionUnsupported")<{
  readonly option: string;
  readonly message: string;
}> {}

/** A mount entry whose disk isn't known yet. */
export class MountDiskUnresolved extends Data.TaggedError("Archil.MountDiskUnresolved")<{
  readonly path: string;
  readonly message: string;
}> {}

/** The disk id of a resolved mount entry's disk, if it has one. */
export const mountDiskId = (disk: unknown): string | undefined =>
  typeof disk === "object" && disk !== null && "diskId" in disk && typeof disk.diskId === "string"
    ? disk.diskId
    : undefined;

/**
 * The wire shape of a sandbox mount. Archil sandboxes mount natively: no
 * `shared` mode, branches, or `force`.
 */
export const toSandboxMount = Effect.fn(function* (diskId: string, mount: DiskMountOptions) {
  const unsupported =
    mount.mode === "shared"
      ? 'mode: "shared"'
      : mount.branch !== undefined
        ? "branch"
        : mount.force
          ? "force"
          : undefined;
  if (unsupported !== undefined) {
    return yield* new MountOptionUnsupported({
      option: unsupported,
      message: `An Archil sandbox can't mount a disk with ${unsupported} (only the FUSE client can); mount it at ${mount.path} without it.`,
    });
  }
  if (mount.queueMs !== undefined && (mount.mode ?? "exclusive") !== "exclusive") {
    return yield* new MountOptionUnsupported({
      option: "queueMs",
      message: `queueMs only applies to exclusive mounts (${mount.path} is ${mount.mode}).`,
    });
  }
  return {
    disk_id: diskId,
    path: mount.path,
    subdirectory: mount.subdirectory,
    read_only: mount.mode === "read-only",
    conditional: mount.mode === "conditional",
    queue_ms: mount.queueMs,
  } satisfies archil.SandboxMount;
});

/** A comparable form of a wire mount, defaults filled in. */
export const mountIdentity = (mount: archil.SandboxMount) => ({
  disk_id: mount.disk_id,
  path: mount.path ?? "/mnt/archil",
  subdirectory: mount.subdirectory || undefined,
  read_only: mount.read_only ?? false,
  conditional: mount.conditional ?? false,
  queue_ms: mount.queue_ms ?? undefined,
});

/** A port a sandbox serves publicly. */
export interface SandboxEndpoint {
  port: number;
  /** Public hostname that routes to the port. */
  hostname: string;
}

const secretValue = (value: string | Redacted.Redacted<string>) =>
  typeof value === "string" ? value : Redacted.value(value);

/** The wire shape of an egress policy. */
export const toEgressPolicy = (egress: SandboxEgress): archil.SandboxEgressPolicy => ({
  default: egress.default,
  allow: egress.allow?.map((entry) =>
    typeof entry === "string"
      ? entry
      : {
          target: entry.target,
          transform: entry.headers
            ? {
                headers: Object.fromEntries(
                  Object.entries(entry.headers).map(([k, v]) => [k, secretValue(v)]),
                ),
              }
            : undefined,
          forward_url: entry.forwardUrl,
        },
  ),
  deny: egress.deny ? [...egress.deny] : undefined,
  drain_on_pause: egress.drainOnPause ? [...egress.drainOnPause] : undefined,
});

const isArchilEgress = (entry: string | object) =>
  typeof entry === "string" && /^(mount|data)\.\*\.archil\.com$/.test(entry);

/**
 * Split off the allow-list entries Archil adds itself to a sandbox that
 * mounts disks (`mount.*.archil.com`, `data.*.archil.com`). They aren't
 * part of the desired policy, but an update must keep them.
 */
export const splitArchilEgress = (egress: archil.SandboxEgressPolicy | undefined) => ({
  managed: (egress?.allow ?? []).filter(isArchilEgress),
  policy: egress && { ...egress, allow: egress.allow?.filter((entry) => !isArchilEgress(entry)) },
});

/** Environment values, unwrapped for the wire. */
export const toEnv = (env: Record<string, string | Redacted.Redacted<string>> | undefined) =>
  env === undefined
    ? undefined
    : Object.fromEntries(Object.entries(env).map(([k, v]) => [k, secretValue(v)]));

/** A comparable form of an egress policy (header values are hashed out). */
export const egressIdentity = (egress: SandboxEgress | undefined) =>
  egress === undefined
    ? undefined
    : {
        ...egress,
        allow: egress.allow?.map((entry) =>
          typeof entry === "string"
            ? entry
            : {
                ...entry,
                headers: entry.headers
                  ? Object.fromEntries(
                      Object.entries(entry.headers).map(([k, v]) => [k, secretValue(v)]),
                    )
                  : undefined,
              },
        ),
      };
