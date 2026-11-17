import * as Cloudflare from "@alchemy.run/cloudflare";

// The live lifecycle suite creates objects; its disposable bucket must be
// deletable even if a request fails before the normal object-cleanup route.
export const Media = Cloudflare.R2.Bucket("AliasMedia", { forceDestroy: true });
export const Events = Cloudflare.Queues.Queue("AliasEvents");
