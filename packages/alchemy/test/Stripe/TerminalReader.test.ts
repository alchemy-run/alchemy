import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import {
  type DeletedTerminalReader,
  GetTerminalReaders,
  GetTerminalReadersReader,
  type TerminalReader as StripeTerminalReader,
} from "@distilled.cloud/stripe/stripe";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({ providers: Stripe.providers() });

/**
 * Registering a Terminal reader normally requires physical hardware in
 * pairing mode. Stripe's test mode accepts this constant registration code
 * instead and registers a `simulated_wisepos_e` device, which is what these
 * tests use. Terminal still has to be enabled on the account, so the whole
 * suite is gated behind `STRIPE_TEST_TERMINAL=1`.
 *
 * @see https://docs.stripe.com/terminal/references/testing
 */
const SIMULATED_REGISTRATION_CODE = "simulated-wpe";

const skipTerminal = process.env.STRIPE_TEST_TERMINAL !== "1";

const registrationCode = Redacted.make(SIMULATED_REGISTRATION_CODE);

/** Fetch a reader out-of-band, mapping "missing"/"deleted" onto `undefined`. */
const fetchReader = Effect.fn(function* (readerId: string) {
  return yield* GetTerminalReadersReader({ reader: readerId }).pipe(
    Effect.map(
      (
        response: StripeTerminalReader | DeletedTerminalReader,
      ): StripeTerminalReader | undefined =>
        "deleted" in response ? undefined : response,
    ),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    Effect.catchTag("InvalidRequestError", (e) =>
      e.code === "resource_missing"
        ? Effect.succeed(undefined)
        : Effect.fail(e),
    ),
  );
});

const location = (id: string, displayName: string) =>
  Stripe.TerminalLocation(id, {
    displayName,
    address: {
      line1: "1 Market Street",
      city: "San Francisco",
      state: "CA",
      postalCode: "94105",
      country: "US",
    },
  });

test.provider.skipIf(skipTerminal)(
  "register and deregister a simulated reader",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const reader = yield* stack.deploy(
        Stripe.TerminalReader("MinimalReader", { registrationCode }),
      );

      expect(reader.readerId).toBeDefined();
      expect(reader.readerId.startsWith("tmr_")).toBe(true);
      expect(reader.deviceType).toContain("simulated");
      expect(reader.serialNumber).toBeDefined();
      expect(reader.livemode).toBe(false);
      // No user metadata was supplied, and alchemy's internal keys must be
      // stripped from the user-facing attribute.
      expect(reader.metadata).toEqual({});

      const fetched = yield* fetchReader(reader.readerId);
      expect(fetched?.id).toEqual(reader.readerId);
      // The branding metadata IS present on the Stripe object.
      expect(fetched?.metadata?.alchemy_id).toBeDefined();

      yield* stack.destroy();

      const afterDestroy = yield* fetchReader(reader.readerId);
      expect(afterDestroy).toBeUndefined();
    }),
  { timeout: 180_000 },
);

test.provider.skipIf(skipTerminal)(
  "register a reader with every prop set",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* location("FullReaderLocation", "Alchemy Full");
          const reader = yield* Stripe.TerminalReader("FullReader", {
            registrationCode,
            locationId: store.terminalLocationId,
            label: "Front counter",
            metadata: { floor: "1", team: "retail" },
          });
          return { store, reader };
        }),
      );

      expect(deployed.reader.label).toEqual("Front counter");
      expect(deployed.reader.locationId).toEqual(
        deployed.store.terminalLocationId,
      );
      expect(deployed.reader.metadata).toEqual({ floor: "1", team: "retail" });

      const fetched = yield* fetchReader(deployed.reader.readerId);
      expect(fetched?.label).toEqual("Front counter");
      expect(fetched?.metadata?.floor).toEqual("1");
      expect(fetched?.metadata?.alchemy_id).toBeDefined();

      yield* stack.destroy();
    }),
  { timeout: 180_000 },
);

test.provider.skipIf(skipTerminal)(
  "update label and metadata in place",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = (label: string, metadata: Record<string, string>) =>
        Effect.gen(function* () {
          const store = yield* location(
            "UpdateReaderLocation",
            "Alchemy Update",
          );
          const reader = yield* Stripe.TerminalReader("UpdateReader", {
            registrationCode,
            locationId: store.terminalLocationId,
            label,
            metadata,
          });
          return { store, reader };
        });

      const created = yield* stack.deploy(
        program("Counter one", { floor: "1", team: "retail" }),
      );
      const updated = yield* stack.deploy(
        program("Counter two", { floor: "2" }),
      );

      // Label and metadata are the only mutable aspects — the reader is
      // updated in place, never replaced.
      expect(updated.reader.readerId).toEqual(created.reader.readerId);
      expect(updated.reader.label).toEqual("Counter two");
      expect(updated.reader.metadata).toEqual({ floor: "2" });

      const fetched = yield* fetchReader(updated.reader.readerId);
      expect(fetched?.label).toEqual("Counter two");
      expect(fetched?.metadata?.floor).toEqual("2");
      // The removed key must be unset on Stripe, not merely dropped from
      // the desired map.
      expect(fetched?.metadata?.team).toBeUndefined();
      expect(fetched?.metadata?.alchemy_id).toBeDefined();

      yield* stack.destroy();
    }),
  { timeout: 180_000 },
);

test.provider.skipIf(skipTerminal)(
  "moving a reader to another location replaces it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = (which: "A" | "B") =>
        Effect.gen(function* () {
          const first = yield* location("ReplaceLocationA", "Alchemy Store A");
          const second = yield* location("ReplaceLocationB", "Alchemy Store B");
          const reader = yield* Stripe.TerminalReader("ReplaceReader", {
            registrationCode,
            locationId:
              which === "A"
                ? first.terminalLocationId
                : second.terminalLocationId,
            label: "Roaming reader",
          });
          return { first, second, reader };
        });

      const created = yield* stack.deploy(program("A"));
      expect(created.reader.locationId).toEqual(
        created.first.terminalLocationId,
      );

      const replaced = yield* stack.deploy(program("B"));

      // Stripe's reader update endpoint accepts only `label` and
      // `metadata`, so a location change must be a replacement.
      expect(replaced.reader.readerId).not.toEqual(created.reader.readerId);
      expect(replaced.reader.locationId).toEqual(
        created.second.terminalLocationId,
      );

      const oldReader = yield* fetchReader(created.reader.readerId);
      expect(oldReader).toBeUndefined();

      const newReader = yield* fetchReader(replaced.reader.readerId);
      expect(newReader?.id).toEqual(replaced.reader.readerId);

      yield* stack.destroy();
    }),
  { timeout: 240_000 },
);

test.provider.skipIf(skipTerminal)(
  "deregistering a reader removes it from the account listing",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const reader = yield* stack.deploy(
        Stripe.TerminalReader("ListedReader", {
          registrationCode,
          label: "Listed reader",
        }),
      );

      const before = yield* GetTerminalReaders({ limit: 100 });
      expect(before.data.map((r) => r.id)).toContain(reader.readerId);

      yield* stack.destroy();

      const after = yield* GetTerminalReaders({ limit: 100 });
      expect(after.data.map((r) => r.id)).not.toContain(reader.readerId);
    }),
  { timeout: 180_000 },
);
