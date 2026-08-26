import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { Page } from "./Page.ts";
import type { Post } from "./Post.ts";
import { bindGcpHost, defaultRoleFor } from "../Host.ts";

type GcpHttpOp<I, A, E> = Effect.Effect<
  (input: I) => Effect.Effect<A, E>,
  never,
  Credentials | HttpClient.HttpClient
> &
  ((input: I) => Effect.Effect<A, E, Credentials | HttpClient.HttpClient>);

/**
 * Shared HTTP scaffolding for Blogger page bindings.
 * NOT exported from index.ts.
 */
export const makePageHttpBinding = <
  I extends { blogId: string; pageId: string },
  A,
  E,
>(options: {
  tag: string;
  role?: string;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (page: Page) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: page,
        iam: [{ role: options.role ?? defaultRoleFor(options.tag) }],
      });
      const blogId = yield* page.blogId;
      const pageId = yield* page.pageId;
      return Effect.fn(`${options.tag}(${page.LogicalId})`)(function* (
        request: Omit<I, "blogId" | "pageId">,
      ) {
        return yield* run({
          ...request,
          blogId: yield* blogId,
          pageId: yield* pageId,
        } as I);
      });
    });
  });

/**
 * Shared HTTP scaffolding for Blogger post bindings.
 * NOT exported from index.ts.
 */
export const makePostHttpBinding = <
  I extends { blogId: string; postId: string },
  A,
  E,
>(options: {
  tag: string;
  role?: string;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (post: Post) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: post,
        iam: [{ role: options.role ?? defaultRoleFor(options.tag) }],
      });
      const blogId = yield* post.blogId;
      const postId = yield* post.postId;
      return Effect.fn(`${options.tag}(${post.LogicalId})`)(function* (
        request: Omit<I, "blogId" | "postId">,
      ) {
        return yield* run({
          ...request,
          blogId: yield* blogId,
          postId: yield* postId,
        } as I);
      });
    });
  });
