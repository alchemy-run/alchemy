import * as Layer from "effect/Layer";
import {
  ClassicMigrationService,
  ClassicMigrationServiceProvider,
} from "./ClassicMigrationService.ts";
import { MigrationService, MigrationServiceProvider } from "./MigrationService.ts";
import { Project, ProjectProvider } from "./Project.ts";
import { SqlMigrationService, SqlMigrationServiceProvider } from "./SqlMigrationService.ts";

export const resources = [ClassicMigrationService, MigrationService, Project, SqlMigrationService];
export const layers = () =>
  Layer.mergeAll(
    ClassicMigrationServiceProvider(),
    MigrationServiceProvider(),
    ProjectProvider(),
    SqlMigrationServiceProvider(),
  );
