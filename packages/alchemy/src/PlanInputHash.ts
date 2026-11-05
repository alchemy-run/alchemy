import { createHash } from "node:crypto";
import * as Duration from "effect/Duration";
import * as Redacted from "effect/Redacted";
import { stripUnresolved } from "./Diff.ts";

const canonical = (value: unknown): unknown => {
  if (Redacted.isRedacted(value)) return ["redacted"];
  if (value instanceof Uint8Array)
    return ["bytes", createHash("sha256").update(value).digest("hex")];
  if (value instanceof Date) return ["date", value.toISOString()];
  if (Duration.isDuration(value)) return ["duration", canonical(value.toJSON())];
  if (Array.isArray(value)) return ["array", value.map(canonical)];
  if (value !== null && typeof value === "object")
    return [
      "object",
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, canonical(child)]),
    ];
  if (typeof value === "number" && !Number.isFinite(value))
    throw new Error("Planned input contains a non-finite number.");
  return value === undefined ? ["undefined"] : ["scalar", value];
};

/** Hashes serializable planned input only, not provider-built artifacts or secret values. */
export const planInputHash = (value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(canonical(stripUnresolved(value))))
    .digest("hex");
