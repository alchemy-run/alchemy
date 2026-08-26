import * as blogger from "@distilled.cloud/gcp/blogger_v3";
import * as Layer from "effect/Layer";
import { makePageHttpBinding } from "./BindingHttp.ts";
import { GetPage } from "./GetPage.ts";

/**
 * HTTP implementation of {@link GetPage}.
 *
 * @layer
 * @provides GCP.Blogger.GetPage
 */
export const GetPageHttp = Layer.effect(
  GetPage,
  makePageHttpBinding({
    tag: "GCP.Blogger.GetPage",
    operation: blogger.getPages,
  }),
);
