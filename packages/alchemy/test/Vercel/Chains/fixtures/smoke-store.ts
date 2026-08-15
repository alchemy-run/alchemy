/**
 * Public blob store bound by the smoke chain's Effect Api. The
 * `ReadWriteBlob` capability binding (not a `projects:` prop) is what
 * connects the Api's project — the chain asserts the connection
 * materialized from the capability alone and that blob data SURVIVES the
 * Api's redeploy cycles (the store is never replaced).
 */
import * as Vercel from "@/Vercel/index.ts";

export const SmokeUploads = Vercel.BlobStore("SmokeUploads", {
  access: "public",
  // The chain leaves blobs in the store at destroy time — without this
  // opt-in the provider surfaces the platform's `not_empty` Conflict
  // (data-protection default) instead of purging.
  forceDestroy: true,
});
