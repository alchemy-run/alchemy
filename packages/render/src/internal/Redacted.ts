import * as Redacted from "effect/Redacted";
import type { SecretString } from "../Types.ts";

export const unwrapSecret = (value: SecretString): string =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

export const unwrapOptionalSecret = (value: SecretString | undefined): string | undefined =>
  value === undefined ? undefined : unwrapSecret(value);

export const toRedacted = (value: SecretString): Redacted.Redacted<string> =>
  Redacted.isRedacted(value) ? value : Redacted.make(value);

export const secretEqual = (a: SecretString | undefined, b: SecretString | undefined): boolean =>
  unwrapOptionalSecret(a) === unwrapOptionalSecret(b);
