import * as Cloudflare from "@alchemy.run/cloudflare";

/** Only its name is used: the capability binds it into the container's env. */
export const SelectableStorage = Cloudflare.R2.Bucket("SelectableStorage", { forceDestroy: true });
