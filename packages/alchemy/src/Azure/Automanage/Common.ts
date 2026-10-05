import { createPhysicalName } from "../../PhysicalName.ts";

/** Generated name for a configuration profile or profile version. */
export const createProfileName = (id: string) =>
  createPhysicalName({ id, maxLength: 64 });

/** Observed configuration dictionary as a plain record. */
export const configurationOf = (
  configuration: unknown,
): Record<string, unknown> =>
  typeof configuration === "object" &&
  configuration !== null &&
  !Array.isArray(configuration)
    ? { ...(configuration as Record<string, unknown>) }
    : {};

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    typeof v === "object" && v !== null && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        )
      : v,
  );

/**
 * True when the observed configuration dictionary differs from the desired
 * one (keys compared case-insensitively, values structurally).
 */
export const configurationDiffers = (
  observed: unknown,
  desired: Record<string, unknown>,
) => {
  const lower = (record: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(record).map(([k, v]) => [k.toLowerCase(), v]),
    );
  return (
    canonical(lower(configurationOf(observed))) !== canonical(lower(desired))
  );
};
