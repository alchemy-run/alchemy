import type { BindingScope } from "../LoadBalancer/BindingScope.ts";
import * as StackitBindings from "../StackitBindings.ts";
import type { Intake } from "./Intake.ts";
import type { Runner } from "./Runner.ts";
import type { User } from "./User.ts";

/**
 * Shared HTTP scaffolding for Intake bindings.
 * NOT exported from index.ts.
 *
 * Grants list exactly what the operation needs, the `x-stackit-authorization` actions in
 * the API spec, on the project holding the resource: STACKIT binds roles on nothing
 * narrower. The spec uses one action per verb for runners, intakes and users alike
 * (`intake.intake.get`, `.list`, `.update`), so a grant reaches all three in that project.
 *
 * The Kafka bindings (`Produce`, `ConsumeDeadLetter`) don't come through here: the broker
 * takes SASL credentials, not a STACKIT identity.
 */

interface HttpBindingOptions<I, A, E> {
  /** Fully-qualified binding tag, e.g. `Stackit.Intake.GetRunner`. */
  tag: string;
  /** The `x-stackit-authorization` action of the operation. */
  permission: string;
  /** The distilled operation; the bound resource's identifiers are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}

/** A binding on a whole project and region: `<Op>Http.ts` is one call to it. */
export const makeIntakeScopeHttpBinding = <I extends { projectId: string; regionId: string }, A, E>(
  options: HttpBindingOptions<I, A, E>,
) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (scope: BindingScope) => ({
      projectId: scope.projectId,
      regionId: scope.region,
    }),
    grants: (scope) => [StackitBindings.grantOn(scope, { permissions: [options.permission] })],
  });

/** A binding on a runner: `<Op>Http.ts` is one call to it. */
export const makeRunnerHttpBinding = <
  I extends { projectId: string; regionId: string; intakeRunnerId: string },
  A,
  E,
>(
  options: HttpBindingOptions<I, A, E>,
) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (runner: Runner) => ({
      projectId: runner.projectId,
      regionId: runner.region,
      intakeRunnerId: runner.runnerId,
    }),
    grants: (runner) => [StackitBindings.grantOn(runner, { permissions: [options.permission] })],
  });

/** A binding on an intake: `<Op>Http.ts` is one call to it. */
export const makeIntakeHttpBinding = <
  I extends { projectId: string; regionId: string; intakeId: string },
  A,
  E,
>(
  options: HttpBindingOptions<I, A, E>,
) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (intake: Intake) => ({
      projectId: intake.projectId,
      regionId: intake.region,
      intakeId: intake.intakeId,
    }),
    grants: (intake) => [StackitBindings.grantOn(intake, { permissions: [options.permission] })],
  });

/** A binding on a user: `<Op>Http.ts` is one call to it. */
export const makeUserHttpBinding = <
  I extends { projectId: string; regionId: string; intakeId: string; intakeUserId: string },
  A,
  E,
>(
  options: HttpBindingOptions<I, A, E>,
) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (user: User) => ({
      projectId: user.projectId,
      regionId: user.region,
      intakeId: user.intakeId,
      intakeUserId: user.userId,
    }),
    grants: (user) => [StackitBindings.grantOn(user, { permissions: [options.permission] })],
  });
