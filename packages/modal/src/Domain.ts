import * as domain from "@distilled.cloud/modal/domain";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { declarable } from "./internal/Declared.ts";
import type { Providers } from "./Providers.ts";

export class DomainUnexpectedResponse extends Data.TaggedError("Modal.DomainUnexpectedResponse")<{
  readonly message: string;
}> {}

export interface DomainProps {
  /** The domain name (`agents.example.com`). Changing it replaces the domain. */
  domainName: string;
}

/** A DNS record to create at your DNS provider. */
export interface DomainDnsRecord {
  readonly type: string;
  readonly name: string;
  readonly value: string;
}

export interface DomainAttributes {
  /** Domain ID. */
  domainId: string;
  /** The domain name. */
  domainName: string;
  /** Records to create at your DNS provider before the certificate issues. */
  dnsRecords: DomainDnsRecord[];
  /** `pending`, `issued`, `failed` or `revoked`. */
  certificateStatus: string;
}

/**
 * A custom domain for Modal web endpoints, sandbox tunnels
 * (`customDomain` on `create`) and model endpoints. Create the records in
 * `dnsRecords` at your DNS provider; Modal issues the certificate once they
 * resolve.
 *
 * :::caution
 * Modal has no API to remove a domain. Destroying this resource stops
 * tracking it; remove the domain in the Modal dashboard.
 * :::
 *
 * ### Adding a domain
 * **Example:** Register a domain and output its DNS records
 * ```typescript
 * // alchemy.run.ts
 * import * as Modal from "@alchemy.run/modal";
 * import * as Alchemy from "alchemy";
 * import * as Effect from "effect/Effect";
 *
 * export default Alchemy.Stack(
 *   "Agents",
 *   { providers: Modal.providers() },
 *   Effect.gen(function* () {
 *     const agents = yield* Modal.Domain("Agents", { domainName: "agents.example.com" });
 *     return { records: agents.dnsRecords, certificate: agents.certificateStatus };
 *   }),
 * );
 * ```
 *
 * ### Serving a sandbox on it
 * **Example:** Tunnels on the custom domain
 * ```typescript
 * const sandbox = yield* sandboxes.create({
 *   encryptedPorts: [3000],
 *   customDomain: "agents.example.com",
 * });
 * ```
 *
 * @resource
 * @product Domain
 */
export const Domain = declarable<Domain>()(Resource<Domain>("Modal.Domain"));

export type Domain = Resource<"Modal.Domain", DomainProps, DomainAttributes, never, Providers>;

const STATUS: Record<string, string> = {
  CERTIFICATE_STATUS_PENDING: "pending",
  CERTIFICATE_STATUS_ISSUED: "issued",
  CERTIFICATE_STATUS_FAILED: "failed",
  CERTIFICATE_STATUS_REVOKED: "revoked",
};

const toAttrs = (d: domain.Domain): DomainAttributes => ({
  domainId: d.domainId ?? "",
  domainName: d.domainName ?? "",
  dnsRecords: (d.dnsRecords ?? []).map((record) => ({
    type: (record.type ?? "").replace(/^DNS_RECORD_TYPE_/, ""),
    name: record.name ?? "",
    value: record.value ?? "",
  })),
  certificateStatus: STATUS[d.certificateStatus ?? ""] ?? "pending",
});

export const DomainProvider = () =>
  Provider.effect(
    Domain,
    Effect.gen(function* () {
      const observe = Effect.fn(function* (domainName: string) {
        const { domains } = yield* domain.listDomain({});
        return (domains ?? []).find((d) => d.domainName === domainName);
      });

      return {
        stables: ["domainId", "domainName"],
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          return news.domainName !== olds?.domainName
            ? ({ action: "replace" } as const)
            : undefined;
        }),
        read: Effect.fn(function* ({ olds, output }) {
          const name = output?.domainName ?? olds?.domainName;
          if (!name) return undefined;
          const found = yield* observe(name);
          return found ? toAttrs(found) : undefined;
        }),
        reconcile: Effect.fn(function* ({ news, session }) {
          // Observe, then ensure; refresh the certificate status either way.
          let found = yield* observe(news.domainName);
          if (!found) {
            yield* session.note(`Adding domain ${news.domainName}...`);
            yield* domain
              .createDomain({ domainName: news.domainName })
              .pipe(Effect.catchTag("DomainAlreadyExists", () => Effect.void));
            found = yield* observe(news.domainName);
          }
          if (!found?.domainId) {
            return yield* new DomainUnexpectedResponse({
              message: `Modal domain ${news.domainName} was not listed after create`,
            });
          }
          const verified = yield* domain
            .verifyDomainCertificate({ domainId: found.domainId })
            .pipe(Effect.catchTag("DomainNotFound", () => Effect.succeed({ domain: found })));
          return toAttrs(verified.domain ?? found);
        }),
        // Modal has no domain delete RPC; see the caution in the JSDoc.
        delete: () => Effect.void,
      };
    }),
  );
