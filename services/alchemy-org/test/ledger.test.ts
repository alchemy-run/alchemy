/**
 * The Ledger's contract, against the in-memory physics (the D1 physics
 * runs the same SQL semantics in the Worker; its lifecycle is covered
 * by the deployed stack).
 */
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { Ledger } from "../src/services/Ledger.ts";
import { LedgerMemory } from "../src/services/LedgerMemory.ts";

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

test("LedgerMemory: offer/duplicate/settle", () =>
  Effect.runPromise(contract.pipe(Effect.provide(LedgerMemory))));
