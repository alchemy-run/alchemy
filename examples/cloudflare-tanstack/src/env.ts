import * as cf from "cloudflare:workers";
import type { WebsiteEnv } from "../alchemy.run.ts";

export const env = cf.env as WebsiteEnv;
