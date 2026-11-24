/**
 * Type-level regressions for `Domain.CommitHook`: the hook returns metadata or
 * nothing and fails only with `CommitRefused`, and the envelope's `metadata` is
 * optional. Compiled, never run.
 */
import * as Domain from "@alchemy.run/domain";
import type * as Aggregate from "@alchemy.run/domain/Aggregate";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertType = <T extends true>(_: T) => {};

// A hook may attach metadata, or nothing.
export const Labels = Layer.succeed(Domain.CommitHook, {
  commit: ({ aggregate, context }) =>
    Effect.succeed({ label: aggregate, sentBy: context["Domain/Originator"] }),
});
export const Quiet = Layer.succeed(Domain.CommitHook, {
  commit: () => Effect.succeed(undefined),
});

// It may refuse, with the instance it refuses and the reason it gives.
export const Tenancy = Layer.succeed(Domain.CommitHook, {
  commit: ({ aggregate, id }) =>
    Effect.fail(new Domain.CommitRefused({ aggregate, id, reason: "suspended" })),
});

// Nothing else may fail: the hook's error is `CommitRefused`.
export const Broken = Layer.succeed(Domain.CommitHook, {
  // @ts-expect-error a hook fails only with CommitRefused
  commit: () => Effect.fail("nope"),
});

// What a hook is handed names the instance and carries the events and the request context.
declare const input: Aggregate.CommitHookInput;
assertType<Equals<typeof input.aggregate, string>>(true);
assertType<Equals<typeof input.id, string>>(true);
assertType<Equals<typeof input.version, number>>(true);
assertType<Equals<typeof input.command, string>>(true);

// An envelope may carry metadata or not, and it is a record of unknowns.
declare const envelope: Aggregate.Envelope;
assertType<Equals<typeof envelope.metadata, { readonly [x: string]: unknown } | undefined>>(true);
// An envelope without metadata omits the key.
export const omitted: Aggregate.Envelope = { ...envelope };

// A defect is narrowed with the guard.
declare const defect: unknown;
if (Domain.isCommitRefused(defect)) {
  assertType<Equals<typeof defect.aggregate, string>>(true);
}
