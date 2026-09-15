import type * as gmailpostmastertools from "@distilled.cloud/gcp/gmailpostmastertools_v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Domain } from "./Domain.ts";

export interface GetDomainRequest extends Omit<
  gmailpostmastertools.GetDomainsRequest,
  "name"
> {}

/**
 * Runtime binding for Postmaster Tools `domains.get`.
 *
 * Bind this operation to a {@link Domain} in a Function/Action init
 * phase. Provide {@link GetDomainHttp}.
 *
 * ### Reading Domains
 * **Example:** Read domain metadata
 * ```typescript
 * const getDomain = yield* GCP.Gmailpostmastertools.GetDomain(domain);
 * const metadata = yield* getDomain({});
 * ```
 *
 * @binding
 * @product GCP
 * @category Gmail Postmaster Tools
 */
export interface GetDomain extends Binding.Service<
  GetDomain,
  "GCP.Gmailpostmastertools.GetDomain",
  (
    domain: Domain,
  ) => Effect.Effect<
    (
      request: GetDomainRequest,
    ) => Effect.Effect<
      gmailpostmastertools.Domain,
      gmailpostmastertools.GetDomainsError,
      RuntimeContext
    >
  >
> {}

export const GetDomain = Binding.Service<GetDomain>(
  "GCP.Gmailpostmastertools.GetDomain",
);
