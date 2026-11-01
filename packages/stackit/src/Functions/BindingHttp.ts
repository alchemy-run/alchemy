import * as StackitBindings from "../StackitBindings.ts";
import type { Function } from "./Function.ts";

/**
 * Shared HTTP scaffolding for Functions bindings.
 * NOT exported from index.ts.
 *
 * Each binding grants a custom role with the permission the spec names for the
 * operation (`x-stackit-authorization`), on the project holding the function,
 * because STACKIT has no role binding on anything narrower (see
 * `StackitBindings`). The role is shared per permission set.
 */

/** Build a binding over one operation on a function. */
export const makeFunctionHttpBinding = <
  I extends { projectId: string; functionId: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.Functions.GetFunction`. */
  tag: string;
  /** The exact permissions the operation needs. */
  permissions: readonly string[];
  /** The distilled operation; the function's project and id are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (fn: Function<any>) => ({ projectId: fn.projectId, functionId: fn.functionId }),
    grants: (fn) => [StackitBindings.grantOn(fn, { permissions: options.permissions })],
  });

/** Build a binding over one operation on a function's project, which it only supplies. */
export const makeProjectHttpBinding = <I extends { projectId: string }, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.Functions.ListFunctions`. */
  tag: string;
  /** The exact permissions the operation needs. */
  permissions: readonly string[];
  /** The distilled operation; the function's project is injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (fn: Function<any>) => ({ projectId: fn.projectId }),
    grants: (fn) => [StackitBindings.grantOn(fn, { permissions: options.permissions })],
  });
