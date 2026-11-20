import * as aoss from "@distilled.cloud/aws/opensearchserverless";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { Collection } from "./Collection.ts";

/**
 * Runtime binding for the `BatchGetCollection` operation scoped to one
 * collection (IAM action `aoss:BatchGetCollection` on the collection ARN).
 *
 * Reads the bound {@link Collection}'s live detail — status, endpoints, KMS
 * key — from inside a function runtime. Useful for discovering the data-plane
 * `collectionEndpoint` at runtime. Provide the implementation with
 * `Effect.provide(AWS.OpenSearchServerless.GetCollectionHttp)`.
 * ### Inspecting Collections
 * **Example:** Read the collection's endpoint and status
 * ```typescript
 * // init — bind the operation to the collection
 * const getCollection = yield* AWS.OpenSearchServerless.GetCollection(collection);
 *
 * // runtime
 * const detail = yield* getCollection();
 * yield* Effect.log(`${detail?.status}: ${detail?.collectionEndpoint}`);
 * ```
 *
 * @binding
 */
export interface GetCollection extends Binding.Service<
  GetCollection,
  "AWS.OpenSearchServerless.GetCollection",
  (
    collection: Collection,
  ) => Effect.Effect<
    () => Effect.Effect<aoss.CollectionDetail | undefined, aoss.BatchGetCollectionError>
  >
> {}
export const GetCollection = Binding.Service<GetCollection>(
  "AWS.OpenSearchServerless.GetCollection",
);

// Bespoke (not the shared scaffolding): BatchGetCollection takes an `ids`
// array rather than a single injected `id`, and the callable unwraps the
// batch response to the bound collection's detail.
export const GetCollectionHttp = Layer.effect(
  GetCollection,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const op = yield* AWSBindings.withCredentials(aoss.batchGetCollection);

    return Effect.fn(function* (collection: Collection) {
      const CollectionId = yield* collection.collectionId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.OpenSearchServerless.GetCollection(${collection})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["aoss:BatchGetCollection"],
              Resource: [Output.interpolate`${collection.collectionArn}`],
            },
          ],
        });
      }
      return Effect.fn(`AWS.OpenSearchServerless.GetCollection(${collection.LogicalId})`)(
        function* () {
          const response = yield* op({ ids: [yield* CollectionId] });
          return response.collectionDetails?.[0];
        },
      );
    });
  }),
);
