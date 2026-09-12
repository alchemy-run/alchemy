import * as gmailpostmastertools from "@distilled.cloud/gcp/gmailpostmastertools_v2";
import * as Layer from "effect/Layer";
import { makeDomainsUserHttpBinding } from "./BindingHttp.ts";
import { GetDomainsUser } from "./GetDomainsUser.ts";

/**
 * HTTP implementation of {@link GetDomainsUser}.
 *
 * @layer
 * @provides GCP.Gmailpostmastertools.GetDomainsUser
 */
export const GetDomainsUserHttp = Layer.effect(
  GetDomainsUser,
  makeDomainsUserHttpBinding({
    tag: "GCP.Gmailpostmastertools.GetDomainsUser",
    operation: gmailpostmastertools.getDomainsUsers,
  }),
);
