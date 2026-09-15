import * as gmailpostmastertools from "@distilled.cloud/gcp/gmailpostmastertools_v2";
import * as Layer from "effect/Layer";
import { makeDomainHttpBinding } from "./BindingHttp.ts";
import { GetDomain } from "./GetDomain.ts";

/**
 * HTTP implementation of {@link GetDomain}.
 *
 * @layer
 * @provides GCP.Gmailpostmastertools.GetDomain
 */
export const GetDomainHttp = Layer.effect(
  GetDomain,
  makeDomainHttpBinding({
    tag: "GCP.Gmailpostmastertools.GetDomain",
    operation: gmailpostmastertools.getDomains,
  }),
);
