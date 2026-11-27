import * as Cloudflare from "@alchemy.run/cloudflare";

/** Where the `save_note` tool keeps what the user asks it to remember. */
export const Notes = Cloudflare.KV.Namespace("Notes", {});
