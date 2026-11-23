/**
 * Type-level regressions for where a query's handler runs: `runs` is one of
 * two places, and changes no caller's types. Compiled under
 * `exactOptionalPropertyTypes` (see ./tsconfig.json), never run.
 */
import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertType = <T extends true>(_: T) => {};

class Seal extends Domain.Query("Seal", {
  input: { target: Schema.String, text: Schema.String },
  success: Schema.String,
}) {}

const handler = Effect.succeed(({ text }: { readonly text: string }) => Effect.succeed(text));

// A Layer picks where its handler runs, or leaves it to the default.
Seal.toLayer(handler, { runs: "host" });
Seal.toLayer(handler, { runs: "caller" });
Seal.toLayer(handler, { take: { default: 10 } });
// @ts-expect-error `runs` is a place, not a flag
Seal.toLayer(handler, { runs: true });
// @ts-expect-error there are only two places
Seal.toLayer(handler, { runs: "worker" });

// What a caller sees does not depend on where the handler runs.
type Runs = NonNullable<Parameters<typeof Seal.toLayer>[1]>["runs"];
assertType<Equals<Runs, "caller" | "host" | undefined>>(true);
