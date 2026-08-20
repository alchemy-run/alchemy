import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import { GetTerminalConfigurationsConfiguration } from "@distilled.cloud/stripe/stripe";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Stripe.providers() });

/**
 * Out-of-band lookup used to verify what actually landed in Stripe.
 * Missing objects surface as `NotFound` or, because distilled dispatches on
 * `error.type` before status, as `InvalidRequestError` with
 * `code === "resource_missing"`.
 */
const getConfiguration = (configurationId: string) =>
  GetTerminalConfigurationsConfiguration({
    configuration: configurationId,
  }).pipe(
    Effect.map((res) => ("deleted" in res ? undefined : res)),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    Effect.catchTag("InvalidRequestError", (e) =>
      e.code === "resource_missing"
        ? Effect.succeed(undefined)
        : Effect.fail(e),
    ),
  );

test.provider("create and delete a configuration with minimal props", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const configuration = yield* stack.deploy(
      Stripe.TerminalConfiguration("MinimalConfiguration"),
    );

    expect(configuration.terminalConfigurationId).toBeDefined();
    expect(configuration.terminalConfigurationId.startsWith("tmc_")).toBe(true);
    // No name supplied — the engine generates a deterministic one, which is
    // the only identity a metadata-less object has.
    expect(configuration.name).toBeDefined();
    expect(configuration.isAccountDefault).toBe(false);

    const fetched = yield* getConfiguration(
      configuration.terminalConfigurationId,
    );
    expect(fetched?.id).toEqual(configuration.terminalConfigurationId);
    expect(fetched?.name).toEqual(configuration.name);

    yield* stack.destroy();

    const afterDestroy = yield* getConfiguration(
      configuration.terminalConfigurationId,
    );
    expect(afterDestroy).toBeUndefined();
  }),
);

test.provider("create a configuration with the full prop surface", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const configuration = yield* stack.deploy(
      Stripe.TerminalConfiguration("FullConfiguration", {
        name: "alchemy-test-full-configuration",
        tipping: {
          usd: {
            percentages: [10, 15, 20],
            fixedAmounts: [100, 200, 300],
            smartTipThreshold: 1000,
          },
        },
        offline: { enabled: true },
        rebootWindow: { startHour: 2, endHour: 4 },
        wifi: {
          type: "personal_psk",
          personalPsk: {
            ssid: "alchemy-test-wifi",
            password: "hunter2hunter2",
          },
        },
      }),
    );

    expect(configuration.name).toEqual("alchemy-test-full-configuration");
    expect(configuration.offline).toEqual({ enabled: true });
    expect(configuration.rebootWindow).toEqual({ startHour: 2, endHour: 4 });
    expect(configuration.tipping?.usd?.percentages).toEqual([10, 15, 20]);
    expect(configuration.tipping?.usd?.fixedAmounts).toEqual([100, 200, 300]);
    expect(configuration.tipping?.usd?.smartTipThreshold).toEqual(1000);
    // Stripe never returns WiFi credentials — only the network's identity.
    expect(configuration.wifiType).toEqual("personal_psk");
    expect(configuration.wifiSsid).toEqual("alchemy-test-wifi");

    const fetched = yield* getConfiguration(
      configuration.terminalConfigurationId,
    );
    expect(fetched?.name).toEqual("alchemy-test-full-configuration");
    expect(fetched?.offline?.enabled).toBe(true);
    expect(fetched?.reboot_window?.start_hour).toEqual(2);
    expect(fetched?.reboot_window?.end_hour).toEqual(4);
    expect(fetched?.tipping?.usd?.percentages).toEqual([10, 15, 20]);

    yield* stack.destroy();
  }),
);

test.provider("update name, tipping and offline mode in place", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const created = yield* stack.deploy(
      Stripe.TerminalConfiguration("UpdatedConfiguration", {
        name: "alchemy-test-configuration-before",
        tipping: { usd: { percentages: [10, 15, 20] } },
        offline: { enabled: false },
      }),
    );
    expect(created.name).toEqual("alchemy-test-configuration-before");
    expect(created.tipping?.usd?.percentages).toEqual([10, 15, 20]);

    const updated = yield* stack.deploy(
      Stripe.TerminalConfiguration("UpdatedConfiguration", {
        name: "alchemy-test-configuration-after",
        tipping: { usd: { percentages: [5, 10, 15], smartTipThreshold: 2000 } },
        offline: { enabled: true },
        rebootWindow: { startHour: 1, endHour: 3 },
      }),
    );

    // Every property of a configuration is mutable — the id must survive.
    expect(updated.terminalConfigurationId).toEqual(
      created.terminalConfigurationId,
    );
    expect(updated.name).toEqual("alchemy-test-configuration-after");
    expect(updated.tipping?.usd?.percentages).toEqual([5, 10, 15]);
    expect(updated.tipping?.usd?.smartTipThreshold).toEqual(2000);
    expect(updated.offline).toEqual({ enabled: true });
    expect(updated.rebootWindow).toEqual({ startHour: 1, endHour: 3 });

    const fetched = yield* getConfiguration(updated.terminalConfigurationId);
    expect(fetched?.name).toEqual("alchemy-test-configuration-after");
    expect(fetched?.offline?.enabled).toBe(true);
    expect(fetched?.reboot_window?.start_hour).toEqual(1);

    yield* stack.destroy();
  }),
);

test.provider("removing a property unsets it on the configuration", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const created = yield* stack.deploy(
      Stripe.TerminalConfiguration("UnsetConfiguration", {
        name: "alchemy-test-configuration-unset",
        offline: { enabled: true },
        rebootWindow: { startHour: 2, endHour: 4 },
      }),
    );
    expect(created.rebootWindow).toEqual({ startHour: 2, endHour: 4 });

    const cleared = yield* stack.deploy(
      Stripe.TerminalConfiguration("UnsetConfiguration", {
        name: "alchemy-test-configuration-unset",
        offline: { enabled: true },
      }),
    );

    expect(cleared.terminalConfigurationId).toEqual(
      created.terminalConfigurationId,
    );
    // Stripe unsets a parameter when it is posted as an empty string.
    expect(cleared.rebootWindow).toBeUndefined();

    const fetched = yield* getConfiguration(cleared.terminalConfigurationId);
    expect(fetched?.reboot_window).toBeUndefined();

    yield* stack.destroy();
  }),
);

test.provider("redeploying an unchanged configuration is a no-op", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const deploy = stack.deploy(
      Stripe.TerminalConfiguration("StableConfiguration", {
        name: "alchemy-test-configuration-stable",
        tipping: { usd: { percentages: [10, 15, 20] } },
        offline: { enabled: true },
      }),
    );

    const created = yield* deploy;
    const again = yield* deploy;

    expect(again.terminalConfigurationId).toEqual(
      created.terminalConfigurationId,
    );
    expect(again.name).toEqual(created.name);
    expect(again.tipping?.usd?.percentages).toEqual([10, 15, 20]);
    expect(again.offline).toEqual({ enabled: true });

    yield* stack.destroy();
  }),
);
