import * as Data from "effect/Data";
import type * as Redacted from "effect/Redacted";

/**
 * What a filesystem binding needs from the host it runs on so the program
 * can mount that filesystem at run time: a client installed in the image,
 * and kernel features (FUSE, NFS) the host must grant.
 *
 * A mount binding (e.g. `Archil.MountDisk`) binds a capability onto its host
 * at deploy time; the host bakes the install lines into its image and checks
 * the requirements at plan time. The mount itself happens later, in the
 * running program, per request, as a scoped resource. A host that cannot
 * satisfy a requirement fails the plan with {@link MountUnsupported} instead
 * of failing at boot.
 *
 * Hosts accept capabilities through the `mounts` field of their binding
 * contract.
 */
export interface MountCapability {
  /**
   * Identity of the capability, e.g. `"archil"`. Capabilities with the same
   * id are installed once, however many bindings contribute them.
   */
  readonly id: string;
  /**
   * Dockerfile instructions that install the client, appended to the host's
   * image before the program is copied in. Run as root.
   */
  readonly install: ReadonlyArray<string>;
  /** Kernel features the host must provide. */
  readonly requires?: {
    /** `/dev/fuse` and `CAP_SYS_ADMIN` (FUSE mounts). */
    readonly fuse?: boolean;
    /** An NFS client (`mount -t nfs`). */
    readonly nfs?: boolean;
  };
  /** Environment the mount client reads at run time. */
  readonly env?: Record<string, string | Redacted.Redacted<string>>;
}

/** The binding-contract slice a mount-capable host accepts. */
export interface MountBinding {
  readonly mounts?: ReadonlyArray<MountCapability>;
}

/** What a host can provide to mount bindings. */
export interface MountHostSupport {
  readonly fuse: boolean;
  readonly nfs: boolean;
}

/** A mount binding was bound to a host that can't provide what it needs. */
export class MountUnsupported extends Data.TaggedError("MountUnsupported")<{
  readonly host: string;
  readonly capability: string;
  readonly requirement: "fuse" | "nfs" | "image";
  readonly message: string;
}> {}

/**
 * The capabilities bound onto a host, de-duplicated by id (first wins), in
 * a stable order so image hashes don't churn.
 */
export const collectMountCapabilities = (
  bindings: ReadonlyArray<{ readonly data: MountBinding }>,
): ReadonlyArray<MountCapability> => {
  const byId = new Map<string, MountCapability>();
  for (const binding of bindings) {
    for (const capability of binding.data.mounts ?? []) {
      if (!byId.has(capability.id)) byId.set(capability.id, capability);
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
};

/** The Dockerfile install lines of a set of capabilities, in order. */
export const mountInstallLines = (
  capabilities: ReadonlyArray<MountCapability>,
): ReadonlyArray<string> => capabilities.flatMap((capability) => capability.install);

/** The runtime environment of a set of capabilities, merged. */
export const mountEnv = (
  capabilities: ReadonlyArray<MountCapability>,
): Record<string, string | Redacted.Redacted<string>> =>
  Object.assign({}, ...capabilities.map((capability) => capability.env ?? {}));

/**
 * Check that a host provides every requirement of its bound capabilities.
 * Returns the first unmet requirement as a {@link MountUnsupported}, or
 * `undefined` when the host satisfies them all.
 */
export const checkMountSupport = (
  host: string,
  capabilities: ReadonlyArray<MountCapability>,
  support: MountHostSupport,
  hint?: string,
): MountUnsupported | undefined => {
  for (const capability of capabilities) {
    for (const requirement of ["fuse", "nfs"] as const) {
      if (capability.requires?.[requirement] && !support[requirement]) {
        return new MountUnsupported({
          host,
          capability: capability.id,
          requirement,
          message: `${host} can't mount ${capability.id}: it doesn't provide ${
            requirement === "fuse" ? "FUSE (/dev/fuse)" : "an NFS client"
          }.${hint ? ` ${hint}` : ""}`,
        });
      }
    }
  }
  return undefined;
};
