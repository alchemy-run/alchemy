import * as Cloudflare from "alchemy/Cloudflare";

/**
 * KV namespace bound by the effectful site's program (`site.ts`). Deployed
 * by the test's stack program (which also yields it for out-of-band
 * assertions); referenced by the impl's capability binding.
 */
export const Users = Cloudflare.KV.Namespace("SvelteKitEffectUsers");
