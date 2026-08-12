import * as Cloudflare from "@/Cloudflare/index.ts";

/**
 * KV namespace bound by the effectful-Website plan fixtures. Plan-level
 * tests never deploy it — it exists so the impl's capability binding has
 * a real resource to collect against.
 */
export const Users = Cloudflare.KV.Namespace("EffectfulPlanUsers");
