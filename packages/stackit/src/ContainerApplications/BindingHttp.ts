import * as StackitBindings from "../StackitBindings.ts";
import type { Application } from "./Application.ts";
import type { Environment } from "./Environment.ts";

/**
 * Shared HTTP scaffolding for Container Applications bindings.
 * NOT exported from index.ts.
 *
 * Each binding grants a custom role with the permission the spec names for the
 * operation (`x-stackit-authorization`), on the project holding the bound resource,
 * because STACKIT has no role binding on anything narrower (see `StackitBindings`).
 * The role is shared per permission set.
 */

/** Build a binding over one operation on an application. */
export const makeApplicationHttpBinding = <
  I extends { projectId: string; region: string; environmentId: string; applicationId: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.ContainerApplications.GetApplication`. */
  tag: string;
  /** The exact permissions the operation needs. */
  permissions: readonly string[];
  /** The distilled operation; the application's project, region, environment and id are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (application: Application<any>) => ({
      projectId: application.projectId,
      region: application.region,
      environmentId: application.environmentId,
      applicationId: application.applicationId,
    }),
    grants: (application) => [
      StackitBindings.grantOn(application, { permissions: options.permissions }),
    ],
  });

/** Build a binding over one operation on an environment. */
export const makeEnvironmentHttpBinding = <
  I extends { projectId: string; region: string; environmentId: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.ContainerApplications.GetEnvironment`. */
  tag: string;
  /** The exact permissions the operation needs. */
  permissions: readonly string[];
  /** The distilled operation; the environment's project, region and id are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (environment: Environment) => ({
      projectId: environment.projectId,
      region: environment.region,
      environmentId: environment.environmentId,
    }),
    grants: (environment) => [
      StackitBindings.grantOn(environment, { permissions: options.permissions }),
    ],
  });

/** Build a binding over one operation on an environment's project, which it only supplies. */
export const makeProjectHttpBinding = <
  I extends { projectId: string; region: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.ContainerApplications.ListEnvironments`. */
  tag: string;
  /** The exact permissions the operation needs. */
  permissions: readonly string[];
  /** The distilled operation; the environment's project and region are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (environment: Environment) => ({
      projectId: environment.projectId,
      region: environment.region,
    }),
    grants: (environment) => [
      StackitBindings.grantOn(environment, { permissions: options.permissions }),
    ],
  });
