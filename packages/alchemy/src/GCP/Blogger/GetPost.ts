import type * as blogger from "@distilled.cloud/gcp/blogger_v3";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Post } from "./Post.ts";

export interface GetPostRequest extends Omit<
  blogger.GetPostsRequest,
  "blogId" | "postId"
> {}

/**
 * Runtime binding for Blogger `posts.get`.
 *
 * Bind this operation to a {@link Post} in a Function/Action init
 * phase. Provide {@link GetPostHttp}.
 *
 * ### Reading Posts
 * **Example:** Read post metadata
 * ```typescript
 * const getPost = yield* GCP.Blogger.GetPost(post);
 * const metadata = yield* getPost({ fetchBody: true });
 * ```
 *
 * @binding
 * @product GCP
 * @category Blogger
 */
export interface GetPost extends Binding.Service<
  GetPost,
  "GCP.Blogger.GetPost",
  (
    post: Post,
  ) => Effect.Effect<
    (
      request: GetPostRequest,
    ) => Effect.Effect<blogger.Post, blogger.GetPostsError, RuntimeContext>
  >
> {}

export const GetPost = Binding.Service<GetPost>("GCP.Blogger.GetPost");
