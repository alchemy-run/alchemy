import { Postgres } from "@/Railway/Postgres.ts";
import { Project } from "@/Railway/Project.ts";

export const Site = Project("Site");

export const Db = Postgres("Db", { project: Site });
