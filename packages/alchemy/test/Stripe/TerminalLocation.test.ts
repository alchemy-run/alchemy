import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import { GetTerminalLocationsLocation } from "@distilled.cloud/stripe/stripe";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Stripe.providers() });

/**
 * Out-of-band lookup used to verify what actually landed in Stripe.
 * Missing objects surface as `NotFound` or, because distilled dispatches on
 * `error.type` before status, as `InvalidRequestError` with
 * `code === "resource_missing"`.
 */
const getLocation = (locationId: string) =>
  GetTerminalLocationsLocation({ location: locationId }).pipe(
    Effect.map((res) => ("deleted" in res ? undefined : res)),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    Effect.catchTag("InvalidRequestError", (e) =>
      e.code === "resource_missing"
        ? Effect.succeed(undefined)
        : Effect.fail(e),
    ),
  );

const US_ADDRESS = {
  line1: "1272 Valencia Street",
  city: "San Francisco",
  state: "CA",
  postalCode: "94110",
  country: "US",
} as const;

const GB_ADDRESS = {
  line1: "10 Downing Street",
  city: "London",
  state: "London",
  postalCode: "SW1A 2AA",
  country: "GB",
} as const;

test.provider("create and delete a location with minimal props", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const location = yield* stack.deploy(
      Stripe.TerminalLocation("MinimalLocation", { address: US_ADDRESS }),
    );

    expect(location.terminalLocationId).toBeDefined();
    expect(location.terminalLocationId.startsWith("tml_")).toBe(true);
    // No displayName supplied — the engine generates a deterministic one.
    expect(location.displayName.length).toBeGreaterThan(0);
    expect(location.address.line1).toEqual(US_ADDRESS.line1);
    expect(location.address.city).toEqual(US_ADDRESS.city);
    expect(location.address.country).toEqual(US_ADDRESS.country);
    // User metadata is exposed without alchemy's reserved keys.
    expect(location.metadata).toEqual({});

    const fetched = yield* getLocation(location.terminalLocationId);
    expect(fetched?.id).toEqual(location.terminalLocationId);
    expect(fetched?.address.postal_code).toEqual(US_ADDRESS.postalCode);
    // Alchemy brands the object so a lost state row can re-adopt it.
    expect(fetched?.metadata?.alchemy_id).toEqual("MinimalLocation");

    yield* stack.destroy();

    const afterDestroy = yield* getLocation(location.terminalLocationId);
    expect(afterDestroy).toBeUndefined();
  }),
);

test.provider("create a location with the full prop surface", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const location = yield* stack.deploy(
      Stripe.TerminalLocation("FullLocation", {
        displayName: "Mission District Store",
        address: { ...US_ADDRESS, line2: "Suite 200" },
        metadata: { region: "west", storeNumber: "17" },
      }),
    );

    expect(location.displayName).toEqual("Mission District Store");
    expect(location.address.line2).toEqual("Suite 200");
    expect(location.metadata).toEqual({ region: "west", storeNumber: "17" });

    const fetched = yield* getLocation(location.terminalLocationId);
    expect(fetched?.display_name).toEqual("Mission District Store");
    expect(fetched?.address.line2).toEqual("Suite 200");
    expect(fetched?.metadata?.region).toEqual("west");
    expect(fetched?.metadata?.storeNumber).toEqual("17");
    expect(fetched?.metadata?.alchemy_id).toEqual("FullLocation");

    yield* stack.destroy();
  }),
);

test.provider("update display name, address and metadata in place", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const created = yield* stack.deploy(
      Stripe.TerminalLocation("UpdatedLocation", {
        displayName: "Original Name",
        address: US_ADDRESS,
        metadata: { keep: "yes", drop: "soon" },
      }),
    );
    expect(created.displayName).toEqual("Original Name");
    expect(created.metadata).toEqual({ keep: "yes", drop: "soon" });

    const updated = yield* stack.deploy(
      Stripe.TerminalLocation("UpdatedLocation", {
        displayName: "Renamed Store",
        address: { ...US_ADDRESS, line1: "500 Market Street" },
        metadata: { keep: "yes" },
      }),
    );

    // Mutable fields converge without replacing the object.
    expect(updated.terminalLocationId).toEqual(created.terminalLocationId);
    expect(updated.displayName).toEqual("Renamed Store");
    expect(updated.address.line1).toEqual("500 Market Street");
    // The removed key was explicitly unset, not left behind.
    expect(updated.metadata).toEqual({ keep: "yes" });

    const fetched = yield* getLocation(updated.terminalLocationId);
    expect(fetched?.display_name).toEqual("Renamed Store");
    expect(fetched?.address.line1).toEqual("500 Market Street");
    expect(fetched?.metadata?.drop).toBeUndefined();

    yield* stack.destroy();
  }),
);

test.provider("redeploying an unchanged location is a no-op", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const deploy = stack.deploy(
      Stripe.TerminalLocation("StableLocation", {
        displayName: "Stable Store",
        address: US_ADDRESS,
        metadata: { region: "west" },
      }),
    );

    const created = yield* deploy;
    const again = yield* deploy;

    expect(again.terminalLocationId).toEqual(created.terminalLocationId);
    expect(again.displayName).toEqual(created.displayName);
    expect(again.metadata).toEqual({ region: "west" });

    yield* stack.destroy();
  }),
);

test.provider("changing the country replaces the location", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const created = yield* stack.deploy(
      Stripe.TerminalLocation("ReplacedLocation", {
        displayName: "Relocating Store",
        address: US_ADDRESS,
      }),
    );
    expect(created.address.country).toEqual("US");

    const replaced = yield* stack.deploy(
      Stripe.TerminalLocation("ReplacedLocation", {
        displayName: "Relocating Store",
        address: GB_ADDRESS,
      }),
    );

    // Stripe cannot move a location between countries — the engine must
    // create a new object and delete the old one.
    expect(replaced.terminalLocationId).not.toEqual(created.terminalLocationId);
    expect(replaced.address.country).toEqual("GB");

    const oldLocation = yield* getLocation(created.terminalLocationId);
    expect(oldLocation).toBeUndefined();

    yield* stack.destroy();
  }),
);

test.provider("apply a terminal configuration to a location", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const { configuration, location } = yield* stack.deploy(
      Effect.gen(function* () {
        const configuration = yield* Stripe.TerminalConfiguration(
          "LocationReaderConfig",
          { offline: { enabled: true } },
        );
        const location = yield* Stripe.TerminalLocation("ConfiguredLocation", {
          displayName: "Configured Store",
          address: US_ADDRESS,
          configurationOverrides: configuration.terminalConfigurationId,
        });
        return { configuration, location };
      }),
    );

    expect(location.configurationOverrides).toEqual(
      configuration.terminalConfigurationId,
    );

    const fetched = yield* getLocation(location.terminalLocationId);
    expect(fetched?.configuration_overrides).toEqual(
      configuration.terminalConfigurationId,
    );

    yield* stack.destroy();
  }),
);
