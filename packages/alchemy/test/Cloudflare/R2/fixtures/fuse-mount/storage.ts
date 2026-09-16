import * as Cloudflare from "@/Cloudflare";

/**
 * The persistence bucket the container mounts at `/persist`. Declared
 * as a deferred constructor so both the stack (deploy) and the
 * container runtime (mount) reference the same resource.
 */
export const Persist = Cloudflare.R2.Bucket("FusePersist");
