import { getWorkspaceDomainOwnershipsVerification } from "@distilled.cloud/prisma/management";
import { Unowned } from "alchemy/AdoptPolicy";
import * as ProviderLayer from "alchemy/Local/ProviderLayer";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type { Providers } from "../Providers.ts";
import { devProvider } from "./DevStub.ts";
import { type ProjectReference, resolveWorkspaceId } from "./DomainOwnership.ts";
import { findOwnership } from "./DomainOwnershipRow.ts";
import { normalizeHostname } from "./Hostname.ts";

export interface DomainVerificationProps {
  /** Project (or project ID) whose workspace proves ownership. */
  project: ProjectReference;
  /** An exact hostname such as `app.example.com`, or a wildcard such as `*.example.com`. */
  domain: string;
}

/**
 * The `TXT` record that proves a Prisma workspace owns a domain, read from
 * Prisma before the record exists. Deleting it is a no-op. A domain ownership
 * the stack did not record makes it unowned, since that row's record belongs
 * to whoever created it. Declared by `Prisma.DomainOwnership`.
 */
export interface DomainVerification extends Resource<
  "Prisma.DomainVerification",
  DomainVerificationProps,
  {
    /** Workspace the record proves ownership for. */
    workspaceId: string;
    /** Domain the record proves ownership of. */
    domain: string;
    /** Name of the `TXT` record, `_prisma-verification.{domain}`. */
    recordName: string;
    /** Value of the `TXT` record; the same for every domain in the workspace. */
    recordValue: string;
  },
  never,
  Providers
> {}

export const DomainVerification = Resource<DomainVerification>("Prisma.DomainVerification");

const ProviderLive = () =>
  Provider.effect(
    DomainVerification,
    Effect.gen(function* () {
      return {
        read: Effect.fn(function* ({ output, olds }) {
          if (output !== undefined) return output;
          if (typeof olds?.domain !== "string") return undefined;
          const workspaceId = yield* resolveWorkspaceId(olds.project);
          const domain = normalizeHostname(olds.domain);
          const existing = yield* findOwnership(workspaceId, domain);
          if (existing === undefined) return undefined;
          return Unowned({
            workspaceId,
            domain,
            recordName: existing.verification.name,
            recordValue: existing.verification.value,
          });
        }),
        reconcile: Effect.fn(function* ({ news }) {
          const workspaceId = yield* resolveWorkspaceId(news.project);
          const domain = normalizeHostname(news.domain);
          const record = yield* getWorkspaceDomainOwnershipsVerification({ workspaceId, domain });
          return {
            workspaceId,
            domain,
            recordName: record.data.name,
            recordValue: record.data.value,
          };
        }),
        delete: Effect.fn(function* () {}),
      };
    }),
  );

const ProviderLocal = () =>
  devProvider(DomainVerification, [], ({ news }) => ({
    workspaceId: "dev:workspace:local",
    domain: String(news.domain),
    recordName: `_prisma-verification.${String(news.domain).replace(/^\*\./, "")}`,
    recordValue: "prisma-verification=dev",
  }));

export const DomainVerificationProvider = () =>
  ProviderLayer.dual(DomainVerification, {
    local: () => ProviderLocal(),
    live: () => ProviderLive(),
  });
