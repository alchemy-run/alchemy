import * as Vercel from "@/Vercel/index.ts";

/**
 * Public blob store bound by the Effect-mode fixture Function. The binding
 * (not a `projects:` prop) is what connects the Function's project — the
 * test asserts the connection materialized from the capability alone.
 */
export const Uploads = Vercel.BlobStore("Uploads", { access: "public" });
