import * as gmailpostmastertools from "@distilled.cloud/gcp/gmailpostmastertools_v2";
import * as Layer from "effect/Layer";
import { makeDomainParentHttpBinding } from "./BindingHttp.ts";
import { QueryDomainStats } from "./QueryDomainStats.ts";

/**
 * HTTP implementation of {@link QueryDomainStats}.
 *
 * @layer
 * @provides GCP.Gmailpostmastertools.QueryDomainStats
 */
export const QueryDomainStatsHttp = Layer.effect(
  QueryDomainStats,
  makeDomainParentHttpBinding({
    tag: "GCP.Gmailpostmastertools.QueryDomainStats",
    operation: gmailpostmastertools.queryDomainsDomainStats,
  }),
);
