import * as Cloudflare from "alchemy/Cloudflare";

export const Db = Cloudflare.D1.Database("Db", { migrations: "./migrations" });
