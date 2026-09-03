import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Account } from "./Account.ts";
import type {
  IssueError,
  IssueRequest,
  IssuedCertificate,
  RevokeError,
  RevokeRequest,
} from "./Client.ts";

/**
 * Issue (and revoke) certificates at runtime as an {@link Account} — for
 * services that terminate TLS themselves and need certificates on demand,
 * like a relay minting `*.<tenant>.example.com` when a tenant first
 * connects.
 *
 * Init binds the account's directory URL, account URL and private key
 * into the host (as secrets where the host supports them). The client
 * returns PEMs and expiry and nothing else: where a certificate goes (a
 * Fly App, KV, disk) is the caller's business.
 *
 * ### Issue on demand
 * Publish the DNS-01 record through any runtime DNS write client wrapped
 * as a solver (`Cloudflare.DNS.acmeDnsSolver(dns)`).
 *
 * **Example:** Mint a wildcard from a Worker and upload it to Fly
 * ```typescript
 * export default class Relay extends Fly.Service<Relay>()(
 *   "Relay",
 *   { app: RelayApp, main: import.meta.url },
 *   Effect.gen(function* () {
 *     const acme = yield* ACME.IssueCertificate(ZeroSsl);
 *     const dns = yield* Cloudflare.DNS.WriteDns(Zone);
 *     const certs = yield* Fly.WriteCertificates(RelayApp);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const issued = yield* acme.issue({
 *           identifiers: ["*.tenant.example.com"],
 *           solver: Cloudflare.DNS.acmeDnsSolver(dns),
 *         });
 *         yield* certs.upload({
 *           hostname: "*.tenant.example.com",
 *           fullchain: issued.chain,
 *           privateKey: issued.privateKey,
 *         });
 *         return HttpServerResponse.text("ok");
 *       }),
 *     };
 *   }).pipe(
 *     Effect.provide(ACME.IssueCertificateHttp),
 *     Effect.provide(Cloudflare.DNS.WriteDnsHttp),
 *     Effect.provide(Fly.WriteCertificatesHttp),
 *   ),
 * ) {}
 * ```
 *
 * ### Rate limits
 * `issue` never retries a rate limit: `AcmeRateLimited` carries the CA's
 * `retryAfter` and the caller decides (queue the tenant, keep serving).
 *
 * ### Which CA from a Cloudflare Worker
 * Let's Encrypt (production and staging) answers `525` to requests from
 * Cloudflare Workers egress, so a Worker cannot issue from it; ZeroSSL and
 * Google Trust Services work. Fly Machines, Lambda and local workerd reach
 * every CA.
 *
 * @binding
 * @product ACME
 * @category Certificates
 */
export interface IssueCertificate extends Binding.Service<
  IssueCertificate,
  "ACME.IssueCertificate",
  (account: Account) => Effect.Effect<IssueCertificateClient>
> {}

export const IssueCertificate = Binding.Service<IssueCertificate>(
  "ACME.IssueCertificate",
);

/** Runtime issuance client bound to one account. */
export interface IssueCertificateClient {
  /** Order, solve DNS-01, finalize and download a certificate. */
  issue<R = never>(
    request: IssueRequest<R>,
  ): Effect.Effect<IssuedCertificate, IssueError, RuntimeContext | R>;
  /** Revoke a certificate (`AcmeAlreadyRevoked` counts as success). */
  revoke(
    request: RevokeRequest,
  ): Effect.Effect<void, RevokeError, RuntimeContext>;
}
