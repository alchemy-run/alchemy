import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { Stream } from "./Stream.ts";
import type { StreamConsumer } from "./StreamConsumer.ts";

export type TaggableResource = Stream | StreamConsumer;

export interface ListTagsForResourceRequest extends Omit<
  Kinesis.ListTagsForResourceInput,
  "ResourceARN"
> {}

/**
 * Runtime binding for `kinesis:ListTagsForResource`.
 *
 * Bind this operation to a `Stream` or `StreamConsumer` to read its tags —
 * the resource ARN is injected automatically. Provide the implementation
 * with `Effect.provide(AWS.Kinesis.ListTagsForResourceHttp)`.
 * ### Inspecting Streams
 * **Example:** Read a Stream's Tags
 * ```typescript
 * // init — works for a Stream or a StreamConsumer
 * const listTagsForResource = yield* AWS.Kinesis.ListTagsForResource(stream);
 *
 * // runtime
 * const result = yield* listTagsForResource();
 * const tags = Object.fromEntries(
 *   (result.Tags ?? []).map((tag) => [tag.Key, tag.Value]),
 * );
 * ```
 *
 * @binding
 */
export interface ListTagsForResource extends Binding.Service<
  ListTagsForResource,
  "AWS.Kinesis.ListTagsForResource",
  (
    resource: TaggableResource,
  ) => Effect.Effect<
    (
      request?: ListTagsForResourceRequest,
    ) => Effect.Effect<Kinesis.ListTagsForResourceOutput, Kinesis.ListTagsForResourceError>
  >
> {}

export const ListTagsForResource = Binding.Service<ListTagsForResource>(
  "AWS.Kinesis.ListTagsForResource",
);

export const ListTagsForResourceHttp = Layer.effect(
  ListTagsForResource,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const listTagsForResource = yield* AWSBindings.withCredentials(Kinesis.listTagsForResource);

    return Effect.fn(function* (resource: TaggableResource) {
      const ResourceARN = yield* getResourceArn(resource);
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.Kinesis.ListTagsForResource(${resource})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["kinesis:ListTagsForResource"],
              Resource: [getResourceArn(resource)],
            },
          ],
        });
      }
      return Effect.fn(`AWS.Kinesis.ListTagsForResource(${resource.LogicalId})`)(function* (
        request?: ListTagsForResourceRequest,
      ) {
        return yield* listTagsForResource({
          ...request,
          ResourceARN: yield* ResourceARN,
        });
      });
    });
  }),
);

const getResourceArn = (resource: TaggableResource) =>
  "consumerArn" in resource ? resource.consumerArn : resource.streamArn;
