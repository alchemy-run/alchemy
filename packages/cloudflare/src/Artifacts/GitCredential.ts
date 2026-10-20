import * as Redacted from "effect/Redacted";

/**
 * Git-over-HTTPS credentials for an Artifacts repository, derived from its
 * `remote` and a repo token (see {@link gitCredential}).
 */
export interface GitCredential {
  /**
   * HTTP Basic username. Artifacts ignores it (any non-empty value works);
   * always `"x"`.
   */
  username: string;
  /**
   * HTTP Basic password: the token secret, i.e. the token with its
   * `?expires=<unix_seconds>` suffix removed. Secret.
   */
  password: string;
  /**
   * Self-contained authenticated remote,
   * `https://x:<secret>@<ACCOUNT_ID>.artifacts.cloudflare.net/git/<ns>/<repo>.git`.
   * Secret — use for short-lived commands (`git clone <url>`), never persist
   * it as a long-lived remote.
   */
  url: string;
  /**
   * `Authorization: Bearer <full token>` header for
   * `git -c http.extraHeader="<extraHeader>" clone <remote>` — the form
   * Cloudflare recommends because it keeps the secret out of the remote URL.
   * Secret.
   */
  extraHeader: string;
}

const unwrap = (token: string | Redacted.Redacted<string>) =>
  Redacted.isRedacted(token) ? Redacted.value(token) : token;

/**
 * The secret part of an Artifacts repo token (`art_v…?expires=<unix>` →
 * `art_v…`), used as the HTTP Basic password.
 */
export const tokenSecret = (token: string | Redacted.Redacted<string>): string => {
  const value = unwrap(token);
  const i = value.indexOf("?expires=");
  return i === -1 ? value : value.slice(0, i);
};

/**
 * The expiry encoded in an Artifacts repo token's `?expires=<unix_seconds>`
 * suffix, or `undefined` if the token carries none.
 */
export const tokenExpiresAt = (token: string | Redacted.Redacted<string>): Date | undefined => {
  const match = /[?&]expires=(\d+)/.exec(unwrap(token));
  return match ? new Date(Number(match[1]) * 1000) : undefined;
};

/**
 * Build git-over-HTTPS credentials for an Artifacts repository.
 *
 * Artifacts accepts a repo token either as `Authorization: Bearer <token>`
 * (`extraHeader`) or as the HTTP Basic password with any non-empty username
 * (`username` / `password` / `url`). See
 * https://developers.cloudflare.com/artifacts/api/git-protocol/.
 *
 * @param remote The repository's HTTPS `remote` (e.g. `Repository.remote`).
 * @param token A repo token — `RepositoryToken.token`, a `createToken()`
 *   `plaintext`, or the `token` returned by create/import/fork.
 */
export const gitCredential = (
  remote: string,
  token: string | Redacted.Redacted<string> | { token: string | Redacted.Redacted<string> },
): GitCredential => {
  const raw =
    typeof token === "object" && !Redacted.isRedacted(token) ? unwrap(token.token) : unwrap(token);
  const password = tokenSecret(raw);
  const url = new URL(remote);
  url.username = "x";
  url.password = password;
  return {
    username: "x",
    password,
    url: url.toString(),
    extraHeader: `Authorization: Bearer ${raw}`,
  };
};
