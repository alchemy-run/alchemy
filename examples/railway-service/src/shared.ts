import * as Railway from "alchemy/Railway";

export const API_PORT = 3000;

/**
 * Parent Project the Service and Postgres share. Name is generated.
 */
export const Site = Railway.Project("Site");

/**
 * Official SSL Postgres in {@link Site}. `ConnectPostgres` packs the
 * private `{name}.railway.internal` URI onto the Service.
 */
export const Db = Railway.Postgres("Db", { project: Site });
