import * as blogger from "@distilled.cloud/gcp/blogger_v3";
import * as Layer from "effect/Layer";
import { makePostHttpBinding } from "./BindingHttp.ts";
import { GetPost } from "./GetPost.ts";

/**
 * HTTP implementation of {@link GetPost}.
 *
 * @layer
 * @provides GCP.Blogger.GetPost
 */
export const GetPostHttp = Layer.effect(
  GetPost,
  makePostHttpBinding({
    tag: "GCP.Blogger.GetPost",
    operation: blogger.getPosts,
  }),
);
