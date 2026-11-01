import { expect } from "@alchemy.run/test";
import * as dremio from "@distilled.cloud/stackit/dremio";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

/**
 * Shared fixtures of the STACKIT Dremio suites.
 *
 * STACKIT bills per started hour, per instance and its allocated memory, once a price
 * applies. Its price list (v1.0.44, read 2026-11-01) has no Dremio row, and a create can take
 * up to 30 minutes, so every suite that creates an instance needs both the provider-wide slow
 * flag `STACKIT_TEST_SLOW` and its own `STACKIT_TEST_DREMIO`. A full run creates five
 * instances: two each in the instance and user suites, one in the bindings suite.
 */
export const slow = !process.env.STACKIT_TEST_SLOW || !process.env.STACKIT_TEST_DREMIO;

/** Two reserved documentation ranges: nothing can connect, which these suites don't need. */
export const CLOSED_ACL = ["192.0.2.1/32", "2001:db8::/32"];

/** A password within the API's limits. These instances accept no connection. */
export const TEST_PASSWORD = Redacted.make("alchemy-test-Passw0rd-1");
/** A second one, for the suites that change it. */
export const OTHER_TEST_PASSWORD = Redacted.make("alchemy-test-Passw0rd-2");

export const userProps = {
  email: "alchemy-test@example.com",
  firstName: "Alchemy",
  lastName: "Test",
  password: TEST_PASSWORD,
};

/** The instance, or `"gone"` on the typed not-found error. */
export const observeInstance = (projectId: string, region: string, instanceId: string) =>
  dremio
    .getDremioInstance({ projectId, regionId: region, dremioId: instanceId })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));

/** The user, or `"gone"` on the typed not-found error. */
export const observeUser = (
  projectId: string,
  region: string,
  instanceId: string,
  userId: string,
) =>
  dremio
    .getDremioUser({ projectId, regionId: region, dremioId: instanceId, dremioUserId: userId })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));

/** Bounded check that an observation reports `"gone"`. */
export const expectGone = <A, E, R>(observe: Effect.Effect<A | "gone", E, R>) =>
  observe.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (state) => state === "gone",
      times: 24,
    }),
    Effect.map((state) => expect(state).toEqual("gone")),
  );
