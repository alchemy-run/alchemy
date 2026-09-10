import type * as PgClient from "@effect/sql-pg/PgClient";
import * as Redacted from "effect/Redacted";

type PgSsl = PgClient.PgPoolConfig["ssl"];

/** `sslmode` values that libpq (and `@effect/sql-pg`'s URL parser) read as "use TLS". */
const TLS_SSL_MODES: ReadonlySet<string> = new Set([
  "require",
  "verify-ca",
  "verify-full",
]);

const isIpLiteral = (hostname: string): boolean =>
  // `new URL` keeps IPv6 literals bracketed; IPv4 is four decimal octets.
  hostname.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);

/**
 * Resolve the `ssl` option to hand `@effect/sql-pg` so a TLS connection
 * carries SNI for the URL's hostname.
 *
 * `@effect/sql-pg` ≥ 4.0.0-rc.113 speaks the Postgres wire protocol itself
 * (no `pg` underneath) and upgrades the socket with
 * `tls.connect({ host, socket })`. Node only sends the SNI extension when
 * `servername` is set explicitly — it is never derived from `host`, and with
 * a caller-supplied `socket` there is no connect step that could fill it in.
 * Servers that route on SNI reject the session: Aurora DSQL answers
 * `unable to accept connection, sni was not received`. node-postgres set
 * `servername = host` for non-IP hosts, which is why this never surfaced
 * before the swap.
 *
 * The result mirrors the URL's own TLS intent so behaviour is unchanged for
 * plaintext URLs: when TLS is requested (`ssl: true`, an `ssl` object, or
 * `sslmode=require|verify-ca|verify-full`) and the host is a name rather
 * than an IP literal, the returned options include `servername`. Otherwise
 * the caller's `ssl` is returned untouched (so `sslmode` in the URL keeps
 * driving the decision inside `@effect/sql-pg`).
 */
export const withServername = (
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
  const hostname = parsed.hostname;
  if (hostname === "" || isIpLiteral(hostname)) return ssl;

  const sslmode = parsed.searchParams.get("sslmode");
  const tlsRequested =
    ssl === true ||
    typeof ssl === "object" ||
    (sslmode !== null && TLS_SSL_MODES.has(sslmode));
  if (!tlsRequested) return ssl;

  return typeof ssl === "object"
    ? { ...ssl, servername: ssl.servername ?? hostname }
    : { servername: hostname };
};
