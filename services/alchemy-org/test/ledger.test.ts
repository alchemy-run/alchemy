/**
 * The Ledger's contract, against both local physics:
 *
 * - memory: offer/duplicate/settle semantics;
 * - sqlite: the same semantics PLUS restart-resume — a NEW Layer
 *   instance over the same file still dedupes what an earlier instance
 *   accepted (the laptop's kill-and-restart story).
 */
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as Layer from "effect/Layer";
import { Ledger } from "../src/services/Ledger.ts";
import { LedgerMemory } from "../src/services/LedgerMemory.ts";
import { LedgerSqlite } from "../src/services/LedgerSqlite.ts";

/** The contract, physics-agnostic: run under any Ledger Layer. */
const contract = Effect.gen(function* () {
  const ledger = yield* Ledger;

  // first sighting of (queue, key) ⇒ accepted…
  expect((yield* ledger.offer("issues", "o/r#1", { title: "t" })).status).toBe(
    "accepted",
  );
  // …every redelivery ⇒ duplicate
  expect((yield* ledger.offer("issues", "o/r#1", { title: "t" })).status).toBe(
    "duplicate",
  );
  expect((yield* ledger.offer("issues", "o/r#1", null)).status).toBe(
    "duplicate",
  );

  // keys are independent; queues are independent
  expect((yield* ledger.offer("issues", "o/r#2", null)).status).toBe(
    "accepted",
  );
  expect((yield* ledger.offer("pull-requests", "o/r#1", null)).status).toBe(
    "accepted",
  );

  // settle is idempotent, unknown keys are a no-op…
  yield* ledger.settle("issues", "o/r#1");
  yield* ledger.settle("issues", "o/r#1");
  yield* ledger.settle("issues", "never-offered");

  // …and a settled key still dedupes: re-admission (the three-valued
  // `settled` answer) is deliberately NOT built yet — see ledger.ts
  expect((yield* ledger.offer("issues", "o/r#1", null)).status).toBe(
    "duplicate",
  );
});

const run = (layer: Layer.Layer<Ledger>) =>
  Effect.runPromise(contract.pipe(Effect.provide(layer)));

test("LedgerMemory: offer/duplicate/settle", () => run(LedgerMemory));

test("LedgerSqlite: offer/duplicate/settle over a real file", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-org-ledger-",
      });
      yield* contract.pipe(Effect.provide(LedgerSqlite(`${dir}/factory.db`)));
    }).pipe(Effect.provide(BunFileSystem.layer), Effect.scoped),
  ));

test("LedgerSqlite: restart-resume — a new Layer over the same file still dedupes", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-org-ledger-",
      });
      const path = `${dir}/factory.db`;

      // first process lifetime: accept two keys, settle one
      yield* Effect.gen(function* () {
        const ledger = yield* Ledger;
        expect((yield* ledger.offer("issues", "o/r#1", null)).status).toBe(
          "accepted",
        );
        expect((yield* ledger.offer("issues", "o/r#2", null)).status).toBe(
          "accepted",
        );
        yield* ledger.settle("issues", "o/r#2");
      }).pipe(Effect.provide(LedgerSqlite(path)));

      // the process is killed and restarted: a NEW Layer instance over
      // the same file — the re-poll's redeliveries collapse, new work
      // is still admitted
      yield* Effect.gen(function* () {
        const ledger = yield* Ledger;
        expect((yield* ledger.offer("issues", "o/r#1", null)).status).toBe(
          "duplicate",
        );
        expect((yield* ledger.offer("issues", "o/r#2", null)).status).toBe(
          "duplicate",
        );
        expect((yield* ledger.offer("issues", "o/r#3", null)).status).toBe(
          "accepted",
        );
      }).pipe(Effect.provide(LedgerSqlite(path)));
    }).pipe(Effect.provide(BunFileSystem.layer), Effect.scoped),
  ));
