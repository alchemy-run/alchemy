import type { Credentials } from "@distilled.cloud/daytona/Credentials";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";
import * as SchemaAST from "effect/SchemaAST";

/** A generated Daytona operation: callable with its input, and an Effect. */
type Operation<I, O, E> = ((input: I) => Effect.Effect<O, E, Credentials | HttpClient.HttpClient>) &
  Effect.Effect<unknown, never, unknown>;

/** Members a sandbox-scoped client fills in itself. */
export type SandboxFixed =
  | "sandboxIdOrName"
  | "sandboxId"
  | "organizationId"
  | "xDaytonaOrganizationID";

/** Members an organization-scoped client fills in itself. */
export type OrganizationFixed = "organizationId" | "xDaytonaOrganizationID";

/** One operation, with the fields the client fixes removed from its input. */
export type ScopedOperation<I, O, E, F extends PropertyKey = SandboxFixed> =
  {} extends Omit<I, F>
    ? (input?: Omit<I, F>) => Effect.Effect<O, E, RuntimeContext>
    : (input: Omit<I, F>) => Effect.Effect<O, E, RuntimeContext>;

/**
 * Every operation of a generated service module (`@distilled.cloud/daytona/process`,
 * `/git`, …), re-exposed with Daytona's own parameters and typed errors,
 * minus the fields the client supplies (the sandbox and organization).
 */
export type ScopedModule<M, F extends PropertyKey = SandboxFixed> = {
  readonly [
    K in keyof M as M[K] extends Operation<any, any, any> ? K : never
  ]: M[K] extends Operation<infer I, infer O, infer E> ? ScopedOperation<I, O, E, F> : never;
};

// Generated operations are plain callables, not Effects, so the name tells
// them apart: a service module exports operations camelCase and its error
// classes and schemas PascalCase.
const isOperation = (
  name: string,
  value: unknown,
): value is (input: unknown) => Effect.Effect<unknown, unknown, unknown> =>
  typeof value === "function" && /^[a-z]/.test(name);

/** The members an operation's input declares, read from its schema on first use. */
const inputMembers = (op: object): ReadonlySet<string> | undefined => {
  if (!("input" in op)) return undefined;
  const schema = op.input;
  if (typeof schema !== "object" || schema === null || !("ast" in schema)) return undefined;
  let ast = schema.ast as SchemaAST.AST;
  while (SchemaAST.isSuspend(ast)) ast = ast.thunk();
  return SchemaAST.isObjects(ast)
    ? new Set(ast.propertySignatures.map((p) => String(p.name)))
    : undefined;
};

/**
 * Wrap every operation of `module`: merge `fixed` into each input and run
 * the call through `run` (which supplies credentials and sandbox scope).
 * `fixed` may be an Effect when the fields are only known at runtime (a
 * sandbox declared at deploy).
 */
export const scopeModule = <M extends object, F extends PropertyKey = SandboxFixed>(
  module: M,
  fixed: Record<string, unknown> | Effect.Effect<Record<string, unknown>, never, RuntimeContext>,
  run: <A, E>(
    effect: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
  ) => Effect.Effect<A, E, RuntimeContext>,
): ScopedModule<M, F> => {
  const fields = Effect.isEffect(fixed) ? fixed : Effect.succeed(fixed);
  return Object.fromEntries(
    Object.entries(module)
      .filter(([name, value]) => isOperation(name, value))
      .map(([name, op]) => {
        // Only the fixed fields the operation takes: the protocol sends any
        // member it doesn't model as a body, which a GET can't carry.
        let members: ReadonlySet<string> | undefined;
        const fixedFor = (all: Record<string, unknown>) => {
          members ??= inputMembers(op) ?? new Set(Object.keys(all));
          return Object.fromEntries(Object.entries(all).filter(([key]) => members!.has(key)));
        };
        const call = op as (
          input: unknown,
        ) => Effect.Effect<unknown, unknown, Credentials | HttpClient.HttpClient>;
        return [
          name,
          (input?: Record<string, unknown>) =>
            Effect.flatMap(fields, (all) => run(call({ ...input, ...fixedFor(all) }))),
        ];
      }),
    // Object.fromEntries can't produce a mapped type; the entries are exactly
    // the module's operations, each wrapped with the signature ScopedModule gives it.
  ) as unknown as ScopedModule<M, F>;
};

/** The named operations of a module, as a module-shaped object. */
export const pick = <M extends object, K extends keyof M>(
  module: M,
  names: readonly K[],
): Pick<M, K> => Object.fromEntries(names.map((name) => [name, module[name]])) as Pick<M, K>;
