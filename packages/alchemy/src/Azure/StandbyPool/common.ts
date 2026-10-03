import { createPhysicalName } from "../../PhysicalName.ts";

/** Standby pool names: 3-24 letters, digits, and hyphens. */
export const createStandbyPoolName = (id: string) =>
  createPhysicalName({ id, maxLength: 24, delimiter: "-" });

export const lower = (value: string | undefined) => value?.toLowerCase();

/** Azure returns display-style or compact locations ("East US" vs "eastus"). */
export const sameLocation = (a: string | undefined, b: string | undefined) =>
  a?.replaceAll(" ", "").toLowerCase() === b?.replaceAll(" ", "").toLowerCase();

/** Order-insensitive, case-insensitive fingerprint of a string list. */
export const sortedKey = (values: ReadonlyArray<string> | undefined) =>
  (values ?? [])
    .map((v) => v.toLowerCase())
    .sort()
    .join("|");
