import type * as PgClient from "@effect/sql-pg/PgClient";
import * as Redacted from "effect/Redacted";

type PgSsl = PgClient.PgPoolConfig["ssl"];

/**
 * `sslmode` values that `@effect/sql-pg`'s URL parser reads as "use TLS"
 * on its own.
 */
const TLS_SSL_MODES: ReadonlySet<string> = new Set([
  "require",
  "verify-ca",
  "verify-full",
]);

/**
 * `sslmode` values `@effect/sql-pg` ≥ 4.0.0-rc.113 refuses unless `ssl` is
 * set explicitly (`sslmode "prefer" is not supported: set ssl explicitly to
 * true or false`). node-postgres treated both as "TLS on" (aliases of
 * `verify-full`), so that is what they resolve to here — the same wire
 * behaviour those URLs had before the swap.
 */
const OPPORTUNISTIC_SSL_MODES: ReadonlySet<string> = new Set([
  "prefer",
  "allow",
]);

const isIpLiteral = (hostname: string): boolean =>
  // `new URL` keeps IPv6 literals bracketed; IPv4 is four decimal octets.
  hostname.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);

/**
 * Resolve the `ssl` option to hand `@effect/sql-pg` for a connection URL.
 *
 * `@effect/sql-pg` ≥ 4.0.0-rc.113 speaks the Postgres wire protocol itself
 * (no `pg` underneath). Two of its choices diverge from node-postgres in
 * ways that break URLs which used to work, and this helper papers over both
 * so every alchemy Postgres layer (`SQL.Postgres`, `Drizzle.Postgres`, the
 * Postgres state store) behaves as it did before the swap:
 *
 * 1. **No SNI.** It upgrades the socket with `tls.connect({ host, socket })`
 *    and Node only sends the SNI extension when `servername` is set
 *    explicitly — it is never derived from `host`. Servers that route on SNI
 *    reject the session (Aurora DSQL: `unable to accept connection, sni was
 *    not received`; Neon likewise). node-postgres set `servername = host` for
 *    non-IP hosts. When TLS is requested and the host is a name, the returned
 *    options include `servername`.
 * 2. **`sslmode=prefer|allow` is an error** unless `ssl` is explicit.
 *    node-postgres read them as "TLS on", and URLs carry them by default in
 *    places (Hyperdrive's local `dev` origin passthrough hands the worker
 *    `?sslmode=prefer`). They resolve to TLS on here as well.
 *
 * TLS is "requested" when `ssl` is `true` or an object, or the URL's
 * `sslmode` is `require|verify-ca|verify-full|prefer|allow`. Otherwise the
 * caller's `ssl` is returned untouched so `sslmode=disable` / a bare URL
 * keep driving the decision inside `@effect/sql-pg`.
 */
export const resolveSsl = (
  url: Redacted.Redacted<string>,
  ssl: PgSsl,
): PgSsl => {
  if (ssl === false) return ssl;
  let parsed: URL;
  try {
    parsed = new URL(Redacted.value(url));
  } catch {
    // Let `@effect/sql-pg` report the malformed URL.
    return ssl;
  }

  const sslmode = parsed.searchParams.get("sslmode");
  const tlsRequested =
    ssl === true ||
    typeof ssl === "object" ||
    (sslmode !== null &&
      (TLS_SSL_MODES.has(sslmode) || OPPORTUNISTIC_SSL_MODES.has(sslmode)));
  if (!tlsRequested) return ssl;

  const hostname = parsed.hostname;
  if (hostname === "" || isIpLiteral(hostname)) {
    // Nothing to put in SNI, but `prefer`/`allow` still need `ssl` to be
    // explicit or `@effect/sql-pg` rejects the URL.
    return ssl ?? true;
  }

  return typeof ssl === "object"
    ? { ...ssl, servername: ssl.servername ?? hostname }
    : { servername: hostname };
};
