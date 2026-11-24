/**
 * A key wrap that keeps an intermediate key: how often it calls the key
 * service, and that shredding still works. The key service here counts its
 * calls, standing in for KMS; `test/AWS/Domain` and `test/GCP/Domain` run
 * the same wrap against the real ones.
 */
import * as Domain from "@alchemy.run/domain";
import { intermediateKeyWrap, rootKeyWrap } from "@alchemy.run/domain/KeyWrap";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { caseNames, runCases } from "./vault/cases.ts";

const Name = Domain.Sealed(Schema.String);

/** A key service that counts what it is asked: a root key wrap, as KMS is. */
const keyService = () => {
  const service = rootKeyWrap(Effect.succeed(Redacted.make("9d".repeat(32))));
  const calls = { make: 0, unwrap: 0 };
  // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- a root key wrap over a constant needs no runtime
  const make = service.make as (
    subject: string,
  ) => Effect.Effect<{ key: string; wrapped: string }, Domain.VaultError>;
  // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- a root key wrap over a constant needs no runtime
  const unwrap = service.unwrap as (
    subject: string,
    wrapped: string,
  ) => Effect.Effect<string, Domain.VaultError>;
  return {
    calls,
    /** One process's wrap over the service: its memory is its own. */
    process: (keep: string | undefined) => {
      const direct = {
        make: (subject: string) =>
          Effect.suspend(() => {
            calls.make++;
            return make(subject);
          }),
        unwrap: (subject: string, wrapped: string) =>
          Effect.suspend(() => {
            calls.unwrap++;
            return unwrap(subject, wrapped);
          }),
      };
      const intermediate = intermediateKeyWrap({
        keep: (keep ?? "0 millis") as never,
        // What a root key wrap stores has `.` in it: an intermediate key's wrapped text has none.
        make: (subject) =>
          Effect.map(direct.make(subject), (made) => ({
            key: made.key,
            wrapped: made.wrapped.replaceAll(".", "~"),
          })),
        unwrap: (subject, wrapped) => direct.unwrap(subject, wrapped.replaceAll("~", ".")),
        direct: direct.unwrap,
      });
      return Layer.succeed(
        Domain.KeyWrap,
        keep === undefined
          ? {
              make: direct.make,
              unwrap: (subject, wrapped) =>
                wrapped.startsWith("i1.")
                  ? intermediate.unwrap(subject, wrapped)
                  : direct.unwrap(subject, wrapped),
            }
          : intermediate,
      );
    },
  };
};

/** A Vault as one process has it, over keys every process shares. */
const vaultIn = (wrap: Layer.Layer<Domain.KeyWrap>, store: Domain.KeyStore["Service"]) =>
  Domain.VaultLive.pipe(Layer.provide(Layer.merge(wrap, Layer.succeed(Domain.KeyStore, store))));

const inVault = <A, E>(
  effect: Effect.Effect<A, E, Domain.Vault>,
  wrap: Layer.Layer<Domain.KeyWrap>,
  store: Domain.KeyStore["Service"],
) => Effect.provide(effect, vaultIn(wrap, store));

describe("Domain Vault with an intermediate key", { tags: ["unit", "local"] }, () => {
  it.live("passes every Vault case", () =>
    Effect.gen(function* () {
      const store = yield* Domain.KeyStore;
      const service = keyService();
      expect(yield* inVault(runCases("kept"), service.process("1 hour"), store)).toEqual(
        Object.fromEntries(caseNames.map((name) => [name, true])),
      );
    }).pipe(Effect.provide(Domain.MemoryKeyStore)),
  );

  it.live("a process calls the key service once, however many subjects it seals and opens", () =>
    Effect.gen(function* () {
      const store = yield* Domain.KeyStore;
      const service = keyService();
      const subjects = Array.from({ length: 25 }, (_, i) => `c-${i}`);
      const sealed = yield* inVault(
        Effect.gen(function* () {
          const vault = yield* Domain.Vault;
          const boxes = yield* Effect.forEach(subjects, (subject) =>
            vault.seal(Name, subject, `name of ${subject}`),
          );
          const opened = yield* Effect.forEach(boxes, (box) => vault.open(Name, box));
          expect(opened.map(Option.getOrNull)).toEqual(subjects.map((s) => `name of ${s}`));
          return boxes;
        }),
        service.process("1 hour"),
        store,
      );
      expect(service.calls).toEqual({ make: 1, unwrap: 0 });

      // Another process opens them all with one call: they share an intermediate key.
      yield* inVault(
        Effect.gen(function* () {
          const vault = yield* Domain.Vault;
          const opened = yield* Effect.forEach(sealed, (box) => vault.open(Name, box));
          expect(opened.every(Option.isSome)).toBe(true);
        }),
        service.process("1 hour"),
        store,
      );
      expect(service.calls).toEqual({ make: 1, unwrap: 1 });
    }).pipe(Effect.provide(Domain.MemoryKeyStore)),
  );

  it.live("without it, every seal and open is a call", () =>
    Effect.gen(function* () {
      const store = yield* Domain.KeyStore;
      const service = keyService();
      yield* inVault(
        Effect.gen(function* () {
          const vault = yield* Domain.Vault;
          for (const subject of ["c-1", "c-2", "c-3"]) {
            const box = yield* vault.seal(Name, subject, "Sam");
            yield* vault.open(Name, box);
          }
        }),
        service.process(undefined),
        store,
      );
      // Each subject: one call to make its key, one to open with it.
      expect(service.calls).toEqual({ make: 3, unwrap: 3 });
    }).pipe(Effect.provide(Domain.MemoryKeyStore)),
  );

  it.live("a shred takes effect at once in a process that holds the intermediate key", () =>
    Effect.gen(function* () {
      const store = yield* Domain.KeyStore;
      const service = keyService();
      const first = service.process("1 hour");
      const second = service.process("1 hour");
      const seal = Effect.gen(function* () {
        const vault = yield* Domain.Vault;
        return [yield* vault.seal(Name, "c-1", "Sam"), yield* vault.seal(Name, "c-2", "Alex")];
      });
      const [sam, alex] = yield* inVault(seal, first, store);
      const open = (box: typeof sam) =>
        Effect.flatMap(Domain.Vault, (vault) => vault.open(Name, box!));
      // The second process has the intermediate key in memory from here on.
      expect(yield* inVault(open(sam), second, store)).toEqual(Option.some("Sam"));
      const callsBefore = { ...service.calls };

      yield* inVault(
        Effect.flatMap(Domain.Vault, (vault) => vault.shred("c-1")),
        first,
        store,
      );

      expect(yield* inVault(open(sam), second, store)).toEqual(Option.none());
      // The other subject sealed under the same intermediate key still opens, with no new call.
      expect(yield* inVault(open(alex), second, store)).toEqual(Option.some("Alex"));
      expect(service.calls).toEqual(callsBefore);
    }).pipe(Effect.provide(Domain.MemoryKeyStore)),
  );

  it.live("an intermediate key is kept no longer than `keep`", () =>
    Effect.gen(function* () {
      const store = yield* Domain.KeyStore;
      const service = keyService();
      const wrap = service.process("60 millis");
      const seal = (subject: string) =>
        Effect.flatMap(Domain.Vault, (vault) => vault.seal(Name, subject, "Sam"));
      const first = yield* inVault(seal("c-1"), wrap, store);
      yield* inVault(seal("c-2"), wrap, store);
      expect(service.calls).toEqual({ make: 1, unwrap: 0 });

      yield* Effect.sleep("120 millis");

      // A new subject gets a new intermediate key, and an old one's is unwrapped again.
      yield* inVault(seal("c-3"), wrap, store);
      expect(service.calls).toEqual({ make: 2, unwrap: 0 });
      const opened = yield* inVault(
        Effect.flatMap(Domain.Vault, (vault) => vault.open(Name, first)),
        wrap,
        store,
      );
      expect(opened).toEqual(Option.some("Sam"));
      expect(service.calls).toEqual({ make: 2, unwrap: 1 });
    }).pipe(Effect.provide(Domain.MemoryKeyStore)),
  );

  it.live("keys stored either way open with the option on or off", () =>
    Effect.gen(function* () {
      const store = yield* Domain.KeyStore;
      const service = keyService();
      const seal = (subject: string) =>
        Effect.flatMap(Domain.Vault, (vault) => vault.seal(Name, subject, subject));
      const open = (box: Domain.Sealed.Value<string>) =>
        Effect.flatMap(Domain.Vault, (vault) => vault.open(Name, box));
      const direct = yield* inVault(seal("c-1"), service.process(undefined), store);
      const kept = yield* inVault(seal("c-2"), service.process("1 hour"), store);
      // Turned on: a key stored before still opens.
      expect(yield* inVault(open(direct), service.process("1 hour"), store)).toEqual(
        Option.some("c-1"),
      );
      // Turned off again: a key stored under an intermediate key still opens.
      expect(yield* inVault(open(kept), service.process(undefined), store)).toEqual(
        Option.some("c-2"),
      );
    }).pipe(Effect.provide(Domain.MemoryKeyStore)),
  );
});
