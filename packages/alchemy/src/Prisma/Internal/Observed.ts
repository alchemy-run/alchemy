import * as Redacted from "effect/Redacted";
import type { DatabaseStatus } from "../Types.ts";

/**
 * Structural shapes for cloud values that reach shared helpers from more than
 * one source.
 *
 * `Types.ts` narrows discriminants to literals (`type: "database"`) and types
 * secrets as plain strings, while the generated distilled schemas type those
 * fields as `string` and `string | Redacted.Redacted<string>`. Helpers used by
 * both migrated and unmigrated resource files therefore accept the minimum
 * each one actually reads, which both sides satisfy.
 */

export interface ObservedEndpoint {
  readonly host?: string;
  readonly connectionString?: string | Redacted.Redacted<string> | undefined;
}

export interface ObservedConnection {
  readonly endpoints?: {
    readonly direct?: ObservedEndpoint | undefined;
    readonly pooled?: ObservedEndpoint | undefined;
    readonly accelerate?: ObservedEndpoint | undefined;
  };
}

export interface ObservedDatabase {
  readonly id: string;
  readonly name: string;
  readonly status: DatabaseStatus;
  readonly defaultConnectionId: string | null;
  readonly connections: ReadonlyArray<
    ObservedConnection & { readonly id: string }
  >;
  readonly region?: { readonly id: string; readonly name: string } | null;
}

export interface ObservedProject {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly defaultRegion: string | null;
  readonly workspace: { readonly id: string };
}

/** Read a possibly-redacted secret as a plain string. */
export const secretValue = (
  value: string | Redacted.Redacted<string> | undefined | null,
): string | undefined =>
  value === undefined || value === null
    ? undefined
    : typeof value === "string"
      ? value
      : Redacted.value(value);
