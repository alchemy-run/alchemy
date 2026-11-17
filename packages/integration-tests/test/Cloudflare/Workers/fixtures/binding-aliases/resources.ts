import * as Cloudflare from "@alchemy.run/cloudflare";

export const Media = Cloudflare.R2.Bucket("AliasMedia");
export const Events = Cloudflare.Queues.Queue("AliasEvents");
