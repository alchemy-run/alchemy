import { getWorkspaceDomainOwnershipsVerification } from "@distilled.cloud/prisma/unstable/management";
import { Unowned } from "alchemy/AdoptPolicy";
import * as ProviderLayer from "alchemy/Local/ProviderLayer";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type { Providers } from "../Providers.ts";
import { devProvider } from "./DevStub.ts";
import {
  domainSharingRecordWith,
  ensureSameWorkspace,
  findOwnership,
  type ProjectReference,
  recordDomainOf,
  resolveWorkspaceId,
} from "./DomainOwnership.ts";
import { normalizeHostname } from "./Hostname.ts";
import { isInputObject } from "./Refs.ts";

export interface DomainVerificationProps {
  /** Project (or project ID) whose workspace proves ownership. */
  project: ProjectReference;
  /** An exact hostname such as `app.example.com`, or a wildcard such as `*.example.com`. */
  domain: string;
  publishesRecord?: boolean;
}

/** The `TXT` record that proves a domain ownership; unowned while a domain ownership this stack did not record shares it. */
export interface DomainVerification extends Resource<
  "Prisma.DomainVerification",
  DomainVerificationProps,
  {
    /** Workspace the record proves ownership for. */
    workspaceId: string;
    /** Domain the record proves ownership of. */
    domain: string;
    /** Name of the `TXT` record, `_prisma-verification.{domain}` without a leading `*.`. */
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
        diff: Effect.fn(function* ({ news, output }) {
          if (!output || !isInputObject(news) || typeof news.domain !== "string") {
            return undefined;
          }
          return normalizeHostname(news.domain) === normalizeHostname(output.domain)
            ? undefined
            : ({ action: "replace" } as const);
        }),
        read: Effect.fn(function* ({ output, olds, previous }) {
          if (output !== undefined) return output;
          if (olds?.publishesRecord !== true || typeof olds.domain !== "string") return undefined;
          const workspaceId = yield* resolveWorkspaceId(olds.project);
          const domain = normalizeHostname(olds.domain);
          const recorded =
            previous?.workspaceId === workspaceId ? normalizeHostname(previous.domain) : undefined;
          const existing = yield* Effect.forEach(
            [domain, domainSharingRecordWith(domain)].filter((each) => each !== recorded),
            (each) => findOwnership(workspaceId, each),
          );
          const unrecorded = existing.find((ownership) => ownership !== undefined);
          if (unrecorded === undefined) return undefined;
          return Unowned({
            workspaceId,
            domain,
            recordName: unrecorded.verification.name,
            recordValue: unrecorded.verification.value,
          });
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          const workspaceId = yield* resolveWorkspaceId(news.project);
          const domain = normalizeHostname(news.domain);
          yield* ensureSameWorkspace(domain, output?.workspaceId, workspaceId);
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
    recordName: `_prisma-verification.${recordDomainOf(String(news.domain))}`,
    recordValue: "prisma-verification=dev",
  }));

export const DomainVerificationProvider = () =>
  ProviderLayer.dual(DomainVerification, {
    local: () => ProviderLocal(),
    live: () => ProviderLive(),
  });
