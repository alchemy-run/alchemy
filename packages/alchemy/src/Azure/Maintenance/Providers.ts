import * as Layer from "effect/Layer";
import {
  ConfigurationAssignment,
  ConfigurationAssignmentProvider,
} from "./ConfigurationAssignment.ts";
import {
  MaintenanceConfiguration,
  MaintenanceConfigurationProvider,
} from "./MaintenanceConfiguration.ts";

export const resources = [ConfigurationAssignment, MaintenanceConfiguration];
export const layers = () =>
  Layer.mergeAll(
    ConfigurationAssignmentProvider(),
    MaintenanceConfigurationProvider(),
  );
