import { Postgres } from "@/Railway/Postgres.ts";
import { Project } from "@/Railway/Project.ts";
import { SUITE_PROJECT_NAME } from "../suiteProjectName.ts";

export const Site = Project("Suite", { name: SUITE_PROJECT_NAME });

export const Db = Postgres("Db", { project: Site });
