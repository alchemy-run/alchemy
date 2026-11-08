import * as Effect from "effect/Effect";
import { StateStoreError } from "./State.ts";

/**
 * The format of what a state store holds, recorded in the store itself so a
 * version of alchemy can refuse a store written in a format it doesn't know.
 *
 * - 1: records may hold secrets sealed by a `StateEncryption`.
 *
 * Bump it whenever stored records change in a way an older version would
 * misread, and every version since format 1 refuses the store.
 */
export const STATE_STORE_FORMAT = 1;

/** The file a file- or object-based store keeps its format record in. */
export const STORE_FORMAT_FILE = "__alchemy_store__.json";

/** The store format record, as stores persist it. */
export interface StoreFormatRecord {
  readonly format: number;
}

/** Parse a stored format record; `undefined` when it isn't one. */
export const parseStoreFormat = (text: string): StoreFormatRecord | undefined => {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" &&
      parsed !== null &&
      "format" in parsed &&
      typeof parsed.format === "number"
      ? { format: parsed.format }
      : undefined;
  } catch {
    return undefined;
  }
};

/** The record a store writes the first time this version uses it. */
export const currentStoreFormat = (): StoreFormatRecord => ({ format: STATE_STORE_FORMAT });

/**
 * Refuse a store a newer version of alchemy wrote, by its recorded format.
 * `label` names it, e.g. `S3 state store 's3://bucket/'`. A store with no
 * record (`undefined`) is from before format records, which this version
 * reads.
 */
export const checkStoreFormat = (label: string, observed: number | undefined) =>
  observed !== undefined && observed > STATE_STORE_FORMAT
    ? Effect.fail(
        new StateStoreError({
          message: `${label} holds state in format ${observed}, newer than this version of alchemy's format ${STATE_STORE_FORMAT}. Upgrade alchemy to use it.`,
        }),
      )
    : Effect.void;
