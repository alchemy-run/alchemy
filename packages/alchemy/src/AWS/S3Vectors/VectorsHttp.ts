import * as s3vectors from "@distilled.cloud/aws/s3vectors";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Index } from "./VectorIndex.ts";
import {
  type DeleteVectorsRequest,
  type GetVectorsRequest,
  type ListVectorsRequest,
  type PutVectorsRequest,
  type QueryVectorsRequest,
  Vectors,
} from "./Vectors.ts";

export const VectorsHttp = Layer.effect(
  Vectors,
  Effect.gen(function* () {
    const putVectors = yield* s3vectors.putVectors;
    const queryVectors = yield* s3vectors.queryVectors;
    const getVectors = yield* s3vectors.getVectors;
    const listVectors = yield* s3vectors.listVectors;
    const deleteVectors = yield* s3vectors.deleteVectors;

    return Effect.fn(function* <I extends Index>(index: I) {
      const IndexArn = yield* index.indexArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.S3Vectors.Vectors(${index}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [
                  "s3vectors:PutVectors",
                  "s3vectors:QueryVectors",
                  "s3vectors:GetVectors",
                  "s3vectors:ListVectors",
                  "s3vectors:DeleteVectors",
                ],
                Resource: [index.indexArn],
              },
            ],
          });
        }
      }
      const label = `AWS.S3Vectors.Vectors(${index.LogicalId})`;
      return {
        put: Effect.fn(`${label}.put`)(function* (request: PutVectorsRequest) {
          const indexArn = yield* IndexArn;
          return yield* putVectors({ ...request, indexArn });
        }),
        query: Effect.fn(`${label}.query`)(function* (
          request: QueryVectorsRequest,
        ) {
          const indexArn = yield* IndexArn;
          return yield* queryVectors({ ...request, indexArn });
        }),
        get: Effect.fn(`${label}.get`)(function* (request: GetVectorsRequest) {
          const indexArn = yield* IndexArn;
          return yield* getVectors({ ...request, indexArn });
        }),
        list: Effect.fn(`${label}.list`)(function* (
          request: ListVectorsRequest,
        ) {
          const indexArn = yield* IndexArn;
          return yield* listVectors({ ...request, indexArn });
        }),
        delete: Effect.fn(`${label}.delete`)(function* (
          request: DeleteVectorsRequest,
        ) {
          const indexArn = yield* IndexArn;
          return yield* deleteVectors({ ...request, indexArn });
        }),
      };
    });
  }),
);
