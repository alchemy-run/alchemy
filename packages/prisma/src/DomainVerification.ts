import * as ProviderLayer from "alchemy/Local/ProviderLayer";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type { App } from "./App.ts";
import { PrismaClient } from "./Client.ts";
import type { Compute } from "./Compute.ts";
import { devProvider } from "./internal/DevStub.ts";
import { ownershipRequiredOf } from "./internal/DomainOwnership.ts";
import type { Providers } from "./Providers.ts";

type AppReference = string | App | Compute;

export interface DomainVerificationProps {
  /**
   * App ID or Compute output in the workspace that will own the domain. It
   * must have a promoted deployment: Prisma checks that before ownership.
   */
  app: AppReference;
  /**
   * Hostname whose ownership the workspace proves.
   */
  hostname: string;
}

export interface DomainVerification extends Resource<
  "Prisma.DomainVerification",
  DomainVerificationProps,
  {
    /**
     * Hostname the record proves ownership of.
     */
    hostname: string;
    /**
     * Name of the `TXT` record to publish, `_prisma-verification.{hostname}`.
     */
    recordName: string;
    /**
     * Value of the `TXT` record to publish, `prisma-verification=<token>`.
     * The token is the same for every hostname in the workspace.
     */
    recordValue: string;
  },
  never,
  Providers
> {}

/**
 * The `TXT` record that proves a Prisma workspace owns a hostname. Prisma
 * refuses a {@link CustomDomain} until the record is published.
 *
 * Prisma only reveals the workspace token when it refuses a domain, so the
 * provider asks for one on a hostname no one can ever verify
 * (`alchemy-ownership-probe.invalid`): Prisma checks ownership before DNS,
 * so the request always fails and never creates a domain. Nothing exists in
 * Prisma for this resource; deleting it is a no-op.
 *
 * `Prisma.Website` composites publish this record for you when `domain`
 * names a DNS host (`domain: { name, dns }`).
 *
 * ### Proving Ownership of a Hostname
 * **Example:** Publish the record before attaching the domain
 * ```typescript
 * const verification = yield* Prisma.DomainVerification("api-verification", {
 *   app,
 *   hostname: "api.example.com",
 * });
 * const record = yield* Cloudflare.DNS.Record("api-verification-record", {
 *   zoneId,
 *   name: verification.recordName,
 *   type: "TXT",
 *   content: verification.recordValue,
 * });
 * ```
 *
 * @resource
 * @product Compute
 */
export const DomainVerification = Resource<DomainVerification>("Prisma.DomainVerification");

/** A hostname under `.invalid` (RFC 2606) can never be verified. */
const PROBE_HOSTNAME = "alchemy-ownership-probe.invalid";

export class PrismaDomainVerificationUnavailable extends Data.TaggedError(
  "PrismaDomainVerificationUnavailable",
)<{
  readonly message: string;
}> {}

const resolveAppId = (app: AppReference) => {
  const value = typeof app === "string" ? app : app.appId;
  return typeof value === "string"
    ? Effect.succeed(value)
    : Effect.fail(new Error("Unable to resolve Prisma app id."));
};

const ProviderLive = () =>
  Provider.effect(
    DomainVerification,
    Effect.gen(function* () {
      const client = yield* PrismaClient;
      return {
        read: Effect.fn(function* ({ output }) {
          return output;
        }),
        reconcile: Effect.fn(function* ({ news }) {
          const appId = yield* resolveAppId(news.app);
          const hostname = news.hostname.trim().replace(/\.$/, "").toLowerCase();
          const probe = yield* client
            .createAppDomain(appId, { hostname: PROBE_HOSTNAME })
            .pipe(Effect.result);
          const refusal = Result.isFailure(probe)
            ? ownershipRequiredOf(probe.failure, PROBE_HOSTNAME)
            : undefined;
          if (!refusal?.recordValue) {
            return yield* new PrismaDomainVerificationUnavailable({
              message: `Prisma did not return a domain ownership token for app '${appId}'${
                Result.isFailure(probe) ? `: ${probe.failure.message}` : ""
              }.`,
            });
          }
          return {
            hostname,
            recordName: `_prisma-verification.${hostname}`,
            recordValue: refusal.recordValue,
          };
        }),
        delete: Effect.fn(function* () {}),
      };
    }),
  );

const ProviderLocal = () =>
  devProvider(DomainVerification, [], ({ news }) => ({
    hostname: news.hostname,
    recordName: `_prisma-verification.${news.hostname}`,
    recordValue: "prisma-verification=dev",
  }));

export const DomainVerificationProvider = () =>
  ProviderLayer.dual(DomainVerification, {
    local: () => ProviderLocal(),
    live: () => ProviderLive(),
  });
