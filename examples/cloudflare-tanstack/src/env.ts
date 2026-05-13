import * as cf from "cloudflare:workers";
import type { WebsiteEnv } from "../alchemy.run.ts";
console.log(cf.env);
export const env = cf.env as WebsiteEnv;
