import { deepEqual } from "alchemy/Diff";
import * as Redacted from "effect/Redacted";

/** Keys every ClickStack resource takes besides its body. */
export interface ClickStackScope {
  /** ID of the service whose ClickStack holds the object. Changing it replaces the object. */
  serviceId: string;
}

/** Fields a response carries that the request never sets. */
const SERVER_FIELDS: Partial<Record<string, true>> = {
  id: true,
  teamId: true,
  createdAt: true,
  updatedAt: true,
  state: true,
  silenced: true,
  executionErrors: true,
  isPredefined: true,
};

const plain = (value: unknown): unknown =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

/**
 * Whether the object ClickStack reports already has every declared field.
 * PUT replaces the whole object, so any declared field that differs means
 * the full desired body is sent again.
 */
export const covers = (observed: object, desired: object, writeOnly: readonly string[] = []) =>
  Object.entries(desired).every(
    ([key, value]) =>
      value === undefined ||
      SERVER_FIELDS[key] === true ||
      writeOnly.includes(key) ||
      deepEqual(plain((observed as Record<string, unknown>)[key]), plain(value)),
  );
