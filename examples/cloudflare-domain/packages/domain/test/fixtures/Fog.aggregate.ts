import * as Domain from "@alchemy.run/domain";
import * as Array from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Cache from "effect/Cache";
import * as Config from "effect/Config";
import * as Cron from "effect/Cron";
import * as Effect from "effect/Effect";
import * as Graph from "effect/Graph";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Pool from "effect/Pool";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Trie from "effect/Trie";

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
export class Remember extends Domain.Command("Remember", { input, events: [Seen] }) {}
export class Borrow extends Domain.Command("Borrow", { input, events: [Seen] }) {}
export class Guard extends Domain.Command("Guard", { input, events: [Seen] }) {}
export class Configure extends Domain.Command("Configure", { input, events: [Seen] }) {}
export class Link extends Domain.Command("Link", { input, events: [Seen] }) {}
export class Tick extends Domain.Command("Tick", { input, events: [Seen] }) {}
export class Index extends Domain.Command("Index", { input, events: [Seen] }) {}
export class Before extends Domain.Command("Before", { input, events: [Seen] }) {}
export class Often extends Domain.Command("Often", { input, events: [Seen] }) {}
export class Stretch extends Domain.Command("Stretch", { input, events: [Seen] }) {}
export class Shape extends Domain.Command("Shape", { input, events: [Seen] }) {}
export class Plain extends Domain.Command("Plain", { input, events: [Seen] }) {}

/**
 * What the prover does not read of the library, each in a command of its
 * own. The report says of each why, and proves nothing about it.
 */
export class Fog extends Domain.Aggregate("Fog", {
  id: Schema.String,
  state: Schema.Struct({ n: Schema.Int }),
  initial: { n: 0 },
  invariants: { NeverBelowZero: (fog) => fog.n >= 0 },
  commands: [
    Race,
    Share,
    Walk,
    Rank,
    Unwrap,
    Roll,
    Spin,
    Turn,
    Remember,
    Borrow,
    Guard,
    Configure,
    Link,
    Tick,
    Index,
    Before,
    Often,
    Stretch,
    Shape,
    Plain,
  ],
  keyOf: (command) => command.id,
  decide: {
    // A stream as what `for await` goes over, which the prover has no model for.
    Race: (_fog, command) => {
      const seen = Stream.toAsyncIterable(Stream.make(command.n, 1));
      return [new Seen({ n: Symbol.asyncIterator in seen ? 1 : 0 })];
    },
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
    // A cache finds what it kept by its key, so the key has to be one the code writes.
    Remember: Effect.fn(function* (_fog, command) {
      const cache = yield* Cache.make({ capacity: 8, lookup: (n: number) => Effect.succeed(n) });
      return [new Seen({ n: yield* Cache.get(cache, command.n) })];
    }),
    // A pool with a strategy of the code's own, which the prover has no model for.
    Borrow: Effect.fn(function* (_fog, command) {
      const pool = yield* Pool.makeWithStrategy({
        acquire: Effect.succeed(command.n),
        min: 1,
        max: 2,
        strategy: {
          run: () => Effect.void,
          onAcquire: () => Effect.void,
          reclaim: () => Effect.succeed(undefined),
        },
      });
      return [new Seen({ n: yield* Pool.get(pool) })];
    }, Effect.scoped),
    // A semaphore with too few permits free waits for another fiber, and a handler is one fiber.
    Guard: Effect.fn(function* (_fog, command) {
      const permits = yield* Semaphore.make(1);
      return [new Seen({ n: yield* Semaphore.withPermits(permits, 2)(Effect.succeed(command.n)) })];
    }),
    // A config is read from the environment.
    Configure: Effect.fn(function* () {
      return [new Seen({ n: yield* Config.Int("N").pipe(Effect.orDie) })];
    }),
    // A graph is built by changing one inside a function.
    Link: (_fog, command) => [
      new Seen({
        n: Graph.nodeCount(
          Graph.directed<number, string>((graph) => void Graph.addNode(graph, command.n)),
        ),
      }),
    ],
    // The next time of a schedule after now: the time is not the command's.
    Tick: () => [new Seen({ n: Cron.next(Cron.parseUnsafe("0 0 * * *")).getTime() })],
    // The time before now, and the times after it: neither is the command's.
    Before: () => [new Seen({ n: Cron.prev(Cron.parseUnsafe("0 0 * * *")).getTime() })],
    Often: () => [
      new Seen({ n: Cron.sequence(Cron.parseUnsafe("0 0 * * *")).next().value.getTime() }),
    ],
    // A trie's own functions are run on values the code writes, not on one a command gives.
    Index: (_fog, command) => [
      new Seen({ n: Trie.size(Trie.insert(Trie.empty<number>(), command.text, 1)) }),
    ],
    // A string method that throws on what the code gives it.
    Stretch: () => [new Seen({ n: "ab".repeat(-1).length })],
    // A schema is built, never run, so this line is passed over. The real code throws on it,
    // and the report says the two differ.
    // A step that gives a plain value where the library runs an effect: the library dies on it,
    // so the command records nothing, whatever the types were told.
    Plain: Effect.fn(function* (_fog, command) {
      const n = yield* Effect.succeed(command.n).pipe(
        Effect.flatMap(((n: number) => n + 1) as never as (n: number) => Effect.Effect<number>),
        Effect.catch(() => Effect.succeed(0)),
      );
      return [new Seen({ n })];
    }),
    Shape: (_fog, command) => {
      Schema.Struct(command.text as never);
      return [new Seen({ n: 1 })];
    },
  },
  evolve: { Seen: (_fog, event) => ({ n: event.n }) },
}) {}
