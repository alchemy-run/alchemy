/**
 * What the Intake fixtures and suites share. Deployed hosts import this, so it stays free
 * of the test runner.
 */
import type * as Stackit from "@alchemy.run/stackit";

/**
 * The Iceberg catalog an intake points at. Whether STACKIT checks it on create isn't known;
 * if a live run reports `failed` on the default, name a real one, such as a
 * `Stackit.Dremio.Instance`'s, with these two variables.
 */
export const CATALOG = {
  uri: process.env.STACKIT_TEST_INTAKE_CATALOG_URI ?? "https://iceberg.example.com/catalog",
  warehouse: process.env.STACKIT_TEST_INTAKE_CATALOG_WAREHOUSE ?? "alchemy-test",
} as const;

/** About 1 GiB per hour, the smallest capacity STACKIT's product page lists. */
export const CAPACITY = {
  maxMessageSizeKiB: 1024,
  maxMessagesPerHour: 1024,
} satisfies Pick<Stackit.Intake.RunnerProps, "maxMessageSizeKiB" | "maxMessagesPerHour">;

/** Meets the API's rule: upper and lower case, a number and another character. */
export const PASSWORD = "Alchemy-test-Pw-1";
