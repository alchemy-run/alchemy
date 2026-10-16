import { createHash } from "node:crypto";
import * as Redacted from "effect/Redacted";

/** Credentials Railway uses to pull a private `image`. */
export interface RegistryCredentials {
  readonly username: string;
  readonly password: Redacted.Redacted<string> | string;
}

const plainPassword = (password: RegistryCredentials["password"]) =>
  Redacted.isRedacted(password) ? Redacted.value(password) : password;

/**
 * Fingerprint recorded as an attribute. Railway never returns stored
 * registry credentials, so this is the only way to tell whether they changed.
 */
export const registryCredentialsDigest = (credentials: RegistryCredentials) =>
  createHash("sha256")
    .update(`${credentials.username}\0${plainPassword(credentials.password)}`, "utf8")
    .digest("hex");

/**
 * Credentials to write, or `undefined` when they are omitted or match the
 * recorded fingerprint. Writing them redeploys the service, so they are only
 * sent on first reconcile, adoption, or a change.
 */
export const registryCredentialsToSend = (
  desired: RegistryCredentials | undefined,
  recordedDigest: string | undefined,
): { username: string; password: string } | undefined =>
  desired === undefined || registryCredentialsDigest(desired) === recordedDigest
    ? undefined
    : { username: desired.username, password: plainPassword(desired.password) };
