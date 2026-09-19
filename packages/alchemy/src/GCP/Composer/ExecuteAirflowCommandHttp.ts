import * as composer from "@distilled.cloud/gcp/composer_v1";
import * as Layer from "effect/Layer";
import { makeEnvironmentHttpBinding } from "./BindingHttp.ts";
import { ExecuteAirflowCommand } from "./ExecuteAirflowCommand.ts";

/**
 * HTTP implementation of {@link ExecuteAirflowCommand}.
 *
 * @layer
 * @provides GCP.Composer.ExecuteAirflowCommand
 */
export const ExecuteAirflowCommandHttp = Layer.effect(
  ExecuteAirflowCommand,
  makeEnvironmentHttpBinding({
    tag: "GCP.Composer.ExecuteAirflowCommand",
    nameKey: "environment",
    operation: composer.executeAirflowCommandProjectsLocationsEnvironments,
  }),
);
