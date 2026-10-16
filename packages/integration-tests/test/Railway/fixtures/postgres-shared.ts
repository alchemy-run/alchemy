import { Postgres } from "alchemy/Railway/Postgres";
import { Partition, Site } from "./suite-env.ts";

export { Site };

export const Db = Postgres("Db", { project: Site, environment: Partition });
