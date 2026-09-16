import * as Cloudflare from "@/Cloudflare";

/**
 * The DEV persistence bucket — a distinct identity from the live
 * fixture's `FusePersist` so `FuseMount.local.test.ts` never shares
 * state with the live `FuseMount.test.ts` deployment when the two
 * files run concurrently.
 */
export const LocalFusePersist = Cloudflare.R2.Bucket("LocalFusePersist");
