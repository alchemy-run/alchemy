import type { Function as LambdaFunction } from "@alchemy.run/aws/Lambda";
import { composeFunctionDomain } from "@alchemy.run/aws/Lambda/FunctionDomain";
import {
  qualifiedArnOf,
  qualifiedNameOf,
  qualifierOf,
  type QualifiedFunctionRef,
} from "@alchemy.run/aws/Lambda/QualifiedArn";
import type { Providers } from "@alchemy.run/aws/Providers";
import type * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";

type Assert<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** The requirement channel of an Effect. */
type Requirements<T> = T extends Effect.Effect<any, any, infer R> ? R : never;

declare const ref: QualifiedFunctionRef;
declare const fn: LambdaFunction;

// `Output`'s `Req` parameter defaults to `any`, so an unannotated return leaks
// a requirement into every Effect that yields it.
export type _ArnOutput = Assert<
  Equal<ReturnType<typeof qualifiedArnOf>, Output.Output<string, never>>
>;
export type _NameOutput = Assert<
  Equal<ReturnType<typeof qualifiedNameOf>, Output.Output<string, never>>
>;
export type _QualifierOutput = Assert<
  Equal<ReturnType<typeof qualifierOf>, Output.Output<string, never>>
>;

const fromRef = () =>
  Effect.gen(function* () {
    return {
      arn: yield* qualifiedArnOf(ref),
      name: yield* qualifiedNameOf(ref),
      qualifier: yield* qualifierOf(ref),
    };
  });

// A deployed Function's attributes satisfy the narrowed host shape.
const fromFunction = () =>
  Effect.gen(function* () {
    return {
      arn: yield* qualifiedArnOf(fn),
      name: yield* qualifiedNameOf(fn),
      qualifier: yield* qualifierOf(fn),
    };
  });

export type _RefYieldsNoRequirement = Assert<
  Equal<Requirements<ReturnType<typeof fromRef>>, never>
>;
export type _FunctionYieldsNoRequirement = Assert<
  Equal<Requirements<ReturnType<typeof fromFunction>>, never>
>;

// The custom-domain composite still requires the AWS provider collection: the
// narrowed host attributes must not widen what a caller provides.
export type _DomainRequirement = Assert<
  Equal<ReturnType<typeof composeFunctionDomain>, Effect.Effect<void, never, Providers>>
>;
