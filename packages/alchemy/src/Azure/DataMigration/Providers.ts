import * as Layer from "effect/Layer";
import {
  MigrationService,
  MigrationServiceProvider,
} from "./MigrationService.ts";
import {
  SqlMigrationService,
  SqlMigrationServiceProvider,
} from "./SqlMigrationService.ts";

export const resources = [MigrationService, SqlMigrationService];
export const layers = () =>
  Layer.mergeAll(MigrationServiceProvider(), SqlMigrationServiceProvider());
