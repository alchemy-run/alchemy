const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const snakeKey = (key: string) => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
const camelKey = (key: string) =>
  key.replace(/_([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());

/**
 * Converts a nested value between Alchemy's camelCase props and Stripe's
 * snake_case wire shape. `metadata` maps hold user keys, so they are copied
 * as-is; `undefined` and `null` entries are dropped.
 */
const convert = (value: unknown, key: (key: string) => string): unknown => {
  if (Array.isArray(value)) return value.map((item) => convert(item, key));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, nested]) => nested !== undefined && nested !== null)
      .map(([name, nested]) => [key(name), name === "metadata" ? nested : convert(nested, key)]),
  );
};

/** camelCase props → Stripe's snake_case request shape. */
export const toWire = <T>(value: unknown): T => convert(value, snakeKey) as T;

/** Stripe's snake_case response → camelCase, with nulls dropped. */
export const fromWire = <T>(value: unknown): T => convert(value, camelKey) as T;
