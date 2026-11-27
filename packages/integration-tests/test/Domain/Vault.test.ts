import * as Domain from "@alchemy.run/domain";
import * as DurableObjects from "@alchemy.run/domain/DurableObjects";
import { InMemory } from "@alchemy.run/domain/InMemory";
import { Internals } from "@alchemy.run/domain/Model";
import { Story } from "@alchemy.run/domain/Story";
import { describe, expect, it } from "@alchemy.run/test";
import * as Cause from "effect/Cause";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { simHost } from "./sim-host.ts";
import { caseNames, runCases } from "./vault/cases.ts";

// ---------------------------------------------------------------- customers with a sealed name

const Name = Domain.Sealed(Schema.String);

class Registered extends Domain.Event("Registered", { name: Name }) {}
class Renamed extends Domain.Event("Renamed", { name: Name }) {}
class Register extends Domain.Command("Register", {
  input: { id: Schema.String, name: Name },
  events: [Registered],
}) {}
class Rename extends Domain.Command("Rename", {
  input: { id: Schema.String, name: Name },
  events: [Renamed],
}) {}
class Customer extends Domain.Aggregate("Customer", {
  id: Schema.String,
  state: Schema.Struct({ name: Schema.NullOr(Name) }),
  initial: { name: null },
  commands: [Register, Rename],
  keyOf: (command) => command.id,
  decide: {
    Register: (_, { name }) => [new Registered({ name })],
    Rename: (_, { name }) => [new Renamed({ name })],
  },
  evolve: {
    Registered: (_, e) => ({ name: e.name }),
    Renamed: (_, e) => ({ name: e.name }),
  },
}) {}

/** What a customer's page shows: the name, still sealed. */
class Card extends Domain.View("Card", {
  from: [Customer],
  key: Customer,
  state: Schema.Struct({ name: Schema.NullOr(Name), renames: Schema.Number }),
  initial: { name: null, renames: 0 },
  evolve: {
    Registered: (card, e) => ({ ...card, name: e.name }),
    Renamed: (card, e) => ({ name: e.name, renames: card.renames + 1 }),
  },
}) {}

/** A customer's name, opened where it is served. */
class WhoIs extends Domain.Query("WhoIs", {
  input: { id: Schema.String },
  success: Schema.Struct({ name: Schema.NullOr(Schema.String) }),
}) {}
const WhoIsLive = WhoIs.toLayer(
  Effect.gen(function* () {
    const vault = yield* Domain.Vault;
    const customers = yield* Customer;
    return Effect.fn(function* ({ id }) {
      const customer = yield* customers.get(id);
      if (customer.name === null) return { name: null };
      const name = yield* vault.open(Name, customer.name).pipe(Effect.orDie);
      return { name: Option.getOrNull(name) };
    });
  }),
);

class People extends Domain.Model("People", {
  aggregates: [Customer],
  views: [Card],
  queries: [WhoIs],
}) {}
/** The same customers, hosted with no Vault. */
class Unsealing extends Domain.Model("Unsealing", { aggregates: [Customer] }) {}
class PeopleApi extends Domain.Api("PeopleApi", {
  model: People,
  commands: ["Register", "Rename"],
  views: ["Card"],
  streams: [],
  queries: ["WhoIs"],
}) {}

const platforms = {
  "in memory": () => InMemory,
  "Durable Objects": () =>
    DurableObjects.makePlatform(simHost({ rowsRead: 0 }, {}).host).pipe(
      Layer.provideMerge(SecureRandom.layerWebCrypto),
    ),
} as const;

const Sealing = Domain.VaultLive.pipe(
  Layer.provide(Layer.merge(Domain.MemoryKeyStore, Domain.NoKeyWrap)),
);

const peopleOn = (platform: keyof typeof platforms) =>
  People.layer(WhoIsLive).pipe(
    Layer.provideMerge(Sealing),
    Layer.provideMerge(platforms[platform]()),
  );

/** The events the model stored for a customer, with the view's state of them, as text. */
const storedText = (id: string) =>
  Effect.gen(function* () {
    const { aggregates } = yield* Internals;
    const events = yield* aggregates.get("Customer")!.events!(id);
    const card = yield* (yield* Card).get(Customer.ref(id));
    return JSON.stringify({ events, card: Option.getOrNull(card) });
  });

const dieOf = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

describe("Domain Vault", { tags: ["unit", "local"] }, () => {
  for (const platform of ["in memory", "Durable Objects"] as const) {
    describe(platform, () => {
      it.live("a command's plain value is sealed before anything is stored", () =>
        Effect.gen(function* () {
          const api = yield* PeopleApi.clientInProcess;
          const receipt = yield* api.Register(
            { id: "c-1", name: Name.plain("c-1", "Sam Goodwin") },
            { consistency: "strong" },
          );
          expect(receipt.version).toBe(1);

          const text = yield* storedText("c-1");
          expect(text).not.toContain("Sam Goodwin");
          expect(text).not.toContain("plain.");
          expect(text).toContain('"box":"v1.');

          // The view carries the sealed value; only the Vault reads it.
          const card = yield* api.Card.get("c-1", { atLeast: receipt });
          expect(card?.name?.subject).toBe("c-1");
          expect(card?.name?.box.startsWith("v1.")).toBe(true);
          expect(yield* api.WhoIs({ id: "c-1" })).toEqual({ name: "Sam Goodwin" });
        }).pipe(Effect.provide(peopleOn(platform))),
      );

      it.live("shredding a subject's key leaves every copy unreadable, and changes no event", () =>
        Effect.gen(function* () {
          const api = yield* PeopleApi.clientInProcess;
          const vault = yield* Domain.Vault;
          yield* api.Register({ id: "c-1", name: Name.plain("c-1", "Sam") });
          const renamed = yield* api.Rename({ id: "c-1", name: Name.plain("c-1", "Samuel") });
          yield* api.Card.get("c-1", { atLeast: renamed });
          yield* api.Register({ id: "c-2", name: Name.plain("c-2", "Alex") });
          const before = yield* storedText("c-1");
          expect(yield* api.WhoIs({ id: "c-1" })).toEqual({ name: "Samuel" });

          yield* vault.shred("c-1");

          expect(yield* api.WhoIs({ id: "c-1" })).toEqual({ name: null });
          expect(yield* storedText("c-1")).toBe(before);
          // The first name was sealed under the same key: it is gone too.
          const card = yield* api.Card.get("c-1");
          expect(Option.isNone(yield* vault.open(Name, card!.name!))).toBe(true);
          // Another subject's key is untouched.
          expect(yield* api.WhoIs({ id: "c-2" })).toEqual({ name: "Alex" });
        }).pipe(Effect.provide(peopleOn(platform))),
      );

      it.live("a scheduled command is stored sealed", () =>
        Effect.gen(function* () {
          const customers = yield* Customer;
          yield* customers.send(new Register({ id: "c-1", name: Name.plain("c-1", "Sam") }));
          yield* customers.schedule(new Rename({ id: "c-1", name: Name.plain("c-1", "Samuel") }), {
            after: "50 millis",
          });
          const api = yield* PeopleApi.clientInProcess;
          const card = yield* (yield* Card).waitFor(Customer.ref("c-1"), { renames: 1 } as never, {
            timeout: "5 seconds",
          });
          expect(card.name?.box.startsWith("v1.")).toBe(true);
          expect(yield* api.WhoIs({ id: "c-1" })).toEqual({ name: "Samuel" });
        }).pipe(Effect.provide(peopleOn(platform))),
      );
    });
  }

  // Every pairing of where keys are kept and what wraps them passes the same cases.
  const RootKey = Domain.RootKeyWrap(Redacted.make("0f".repeat(32)));
  const vaults = {
    "memory, unwrapped": Layer.merge(Domain.MemoryKeyStore, Domain.NoKeyWrap),
    "memory, under a root key": Layer.merge(Domain.MemoryKeyStore, RootKey),
    "the in-memory host, under a root key": Layer.merge(
      Domain.HostKeyStore.pipe(Layer.provide(InMemory)),
      RootKey,
    ),
    "Durable Objects, unwrapped": Layer.merge(
      Domain.HostKeyStore.pipe(Layer.provide(platforms["Durable Objects"]())),
      Domain.NoKeyWrap,
    ),
    "Durable Objects, under a root key": Layer.merge(
      Domain.HostKeyStore.pipe(Layer.provide(platforms["Durable Objects"]())),
      RootKey,
    ),
  } as const;
  for (const [name, keys] of Object.entries(vaults)) {
    it.live(`keys in ${name}`, () =>
      Effect.gen(function* () {
        const results = yield* runCases("vault");
        expect(results).toEqual(Object.fromEntries(caseNames.map((name) => [name, true])));
      }).pipe(Effect.provide(Domain.VaultLive.pipe(Layer.provide(keys)))),
    );
  }

  it.live("a key store under a root key holds nothing that opens a value on its own", () =>
    Effect.gen(function* () {
      const store = yield* Domain.KeyStore;
      const seal = (root: string) =>
        Effect.gen(function* () {
          const vault = yield* Domain.Vault;
          return yield* vault.seal(Name, "c-1", "Sam");
        }).pipe(
          Effect.provide(
            Domain.VaultLive.pipe(
              Layer.provide(Domain.RootKeyWrap(Redacted.make(root))),
              Layer.provide(Layer.succeed(Domain.KeyStore, store)),
            ),
          ),
        );
      const sealed = yield* seal("a".repeat(64));
      // What is stored is not the key: it is the key under the root key.
      // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- the in-memory store needs no runtime
      const read = store.get("c-1") as Effect.Effect<Option.Option<string>, Domain.VaultError>;
      const stored = Option.getOrThrow(yield* read);
      expect(stored.startsWith("r1.")).toBe(true);
      // Under another root key the stored key does not unwrap, and nothing is sealed or opened.
      const other = yield* Effect.gen(function* () {
        const vault = yield* Domain.Vault;
        return yield* vault.open(Name, sealed).pipe(Effect.flip);
      }).pipe(
        Effect.provide(
          Domain.VaultLive.pipe(
            Layer.provide(Domain.RootKeyWrap(Redacted.make("b".repeat(64)))),
            Layer.provide(Layer.succeed(Domain.KeyStore, store)),
          ),
        ),
      );
      expect(other.reason).toContain("does not unwrap under this root key");
    }).pipe(Effect.provide(Domain.MemoryKeyStore)),
  );

  it.live("a value sealed in server code opens, and not under another subject or a later key", () =>
    Effect.gen(function* () {
      const vault = yield* Domain.Vault;
      const sealed = yield* vault.seal(Name, "c-1", "Sam");
      expect(sealed.box).not.toContain("Sam");
      expect(yield* vault.open(Name, sealed)).toEqual(Option.some("Sam"));
      // The same value seals to a different box each time.
      expect((yield* vault.seal(Name, "c-1", "Sam")).box).not.toBe(sealed.box);

      // A box is bound to its subject: under another one it is refused.
      yield* vault.seal(Name, "c-2", "Alex");
      expect(yield* vault.open(Name, { ...sealed, subject: "c-2" })).toEqual(Option.none());
      // A box this vault did not seal is an error, not a missing value.
      const foreign = yield* vault
        .open(Name, { subject: "c-1", box: "nonsense" })
        .pipe(Effect.flip);
      expect(foreign._tag).toBe("VaultError");

      yield* vault.shred("c-1");
      expect(yield* vault.open(Name, sealed)).toEqual(Option.none());
      // A subject sealed for again gets a new key: what was shredded stays unreadable.
      const again = yield* vault.seal(Name, "c-1", "Sam");
      expect(yield* vault.open(Name, again)).toEqual(Option.some("Sam"));
      expect(yield* vault.open(Name, sealed)).toEqual(Option.none());
    }).pipe(Effect.provide(Sealing)),
  );

  it.live("a model with no Vault stores nothing of a value waiting to be sealed", () =>
    Effect.gen(function* () {
      const customers = yield* Customer;
      const exit = yield* customers
        .send(new Register({ id: "c-1", name: Name.plain("c-1", "Sam") }))
        .pipe(Effect.exit);
      expect((dieOf(exit) as { readonly _tag?: string })?._tag).toBe("VaultMissing");
      const { aggregates } = yield* Internals;
      expect(yield* aggregates.get("Customer")!.events!("c-1")).toEqual([]);
    }).pipe(Effect.provide(Unsealing.layer(Layer.empty).pipe(Layer.provideMerge(InMemory)))),
  );

  it.live("a plain value that reaches an event outside a command is never stored", () =>
    Effect.gen(function* () {
      const customers = yield* Customer;
      const exit = yield* customers
        .import("c-1", [new Registered({ name: Name.plain("c-1", "Sam") })], {
          commandId: "import-1",
        })
        .pipe(Effect.exit);
      expect((dieOf(exit) as { readonly _tag?: string })?._tag).toBe("Unsealed");
      // Sealed first, the same import is stored.
      const vault = yield* Domain.Vault;
      yield* customers.import(
        "c-1",
        [new Registered({ name: yield* vault.seal(Name, "c-1", "Sam") })],
        { commandId: "import-2" },
      );
      expect(yield* storedText("c-1")).not.toContain("Sam");
    }).pipe(Effect.provide(peopleOn("in memory"))),
  );

  describe("in a story", () => {
    const story = Story.make(People, { layer: WhoIsLive });
    const sam = Customer.ref("c-1");

    it.effect("the test Vault seals the same value the same way, and shreds", () =>
      story(
        Story.when(new Register({ id: sam.id, name: Name.plain(sam.id, "Sam") })),
        Story.then(sam, new Registered({ name: Domain.sealedInTest(Name, sam.id, "Sam") })),
        Story.view(Card, sam, { name: Domain.sealedInTest(Name, sam.id, "Sam") }),
        Story.query(WhoIs, { id: sam.id }, { name: "Sam" }),
        Story.shred(sam.id),
        Story.query(WhoIs, { id: sam.id }, { name: null }),
        // The events are what they were.
        Story.state(sam, { name: Domain.sealedInTest(Name, sam.id, "Sam") }),
      ),
    );
  });
});
