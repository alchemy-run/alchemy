import * as Vercel from "@/Vercel/index.ts";

/**
 * The chain's blob store. The Effect-mode fixture Functions bind it via
 * `ReadWriteBlob`, which is what connects the Function's project (and
 * makes the platform inject `BLOB_READ_WRITE_TOKEN`).
 *
 * The chain test re-registers the SAME logical id with `access: "private"`
 * in its replacement cycle — registration is FQN-idempotent and
 * first-registration-wins, so the fixture's yield resolves to whatever the
 * cycle's deploy program declared.
 */
export const ChainStore = Vercel.BlobStore("ChainStore", {
  access: "public",
  // The chain leaves blobs behind on purpose (replacement + destroy of a
  // non-empty store) — opt into the purge-on-delete path.
  forceDestroy: true,
});
