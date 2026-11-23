import * as Domain from "@alchemy.run/domain";
import * as Array from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Effect from "effect/Effect";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

export class Seen extends Domain.Event("Seen", { n: Schema.Int }) {}

const input = { id: Schema.String, n: Schema.Int, text: Schema.String, price: Schema.BigDecimal };

export class Race extends Domain.Command("Race", { input, events: [Seen] }) {}
export class Share extends Domain.Command("Share", { input, events: [Seen] }) {}
export class Walk extends Domain.Command("Walk", { input, events: [Seen] }) {}
export class Rank extends Domain.Command("Rank", { input, events: [Seen] }) {}
export class Unwrap extends Domain.Command("Unwrap", { input, events: [Seen] }) {}
export class Roll extends Domain.Command("Roll", { input, events: [Seen] }) {}
export class Spin extends Domain.Command("Spin", { input, events: [Seen] }) {}
export class Turn extends Domain.Command("Turn", { input, events: [Seen] }) {}

/**
 * What the prover does not read of the library, each in a command of its
 * own. The report says of each why, and proves nothing about it.
 */
export class Fog extends Domain.Aggregate("Fog", {
  id: Schema.String,
  state: Schema.Struct({ n: Schema.Int }),
  initial: { n: 0 },
  invariants: { NeverBelowZero: (fog) => fog.n >= 0 },
  commands: [Race, Share, Walk, Rank, Unwrap, Roll, Spin, Turn],
  keyOf: (command) => command.id,
  decide: {
    // Several items at a time: which finishes first is not a thing the code decides.
    Race: Effect.fn(function* (_fog, command) {
      const seen = yield* Stream.make(command.n, 1).pipe(
        Stream.mapEffect((n) => Effect.succeed(n), { concurrency: 2 }),
        Stream.runCollect,
      );
      return [new Seen({ n: seen.length })];
    }),
    // A division the library rounds where it does not end.
    Share: (_fog, command) =>
      Option.match(BigDecimal.divide(command.price, BigDecimal.fromNumberUnsafe(3)), {
        onNone: () => [],
        onSome: (share) => [new Seen({ n: BigDecimal.sign(share) })],
      }),
    // Five items, read in the order of their hashes.
    Walk: (_fog, command) => [
      new Seen({
        n: HashSet.reduce(HashSet.make(1, 2, 3, 4, command.n), 0, (first, n) =>
          first === 0 ? n : first,
        ),
      }),
    ],
    // Two strings an input holds, in the order of their letters.
    Rank: (_fog, command) => [new Seen({ n: Order.String(command.text, "m") })],
    // An `Option` is not an effect: `yield*` on one outside `Option.gen` fails where it runs.
    Unwrap: Effect.fn(function* (_fog, command) {
      const n = yield* Option.some(command.n) as unknown as Effect.Effect<number>;
      return [new Seen({ n })];
    }),
    // A random number is not a function of the command.
    Roll: Effect.fn(function* () {
      return [new Seen({ n: yield* Random.nextIntBetween(1, 6) })];
    }),
    // A stream that never ends, run to its end.
    Spin: Effect.fn(function* (_fog, command) {
      const n = yield* Stream.iterate(command.n, (n) => n + 1).pipe(Stream.runCount);
      return [new Seen({ n })];
    }),
    // A function the prover has no model for is run as it is, but only on values the code writes.
    Turn: (_fog, command) => [new Seen({ n: Array.rotate([command.n, 2, 3], 1)[0] ?? 0 })],
  },
  evolve: { Seen: (_fog, event) => ({ n: event.n }) },
}) {}
