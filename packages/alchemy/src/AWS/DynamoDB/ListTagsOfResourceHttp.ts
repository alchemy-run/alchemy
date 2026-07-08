import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import type { Table } from "./Table.ts";
import {
  ListTagsOfResource,
  type ListTagsOfResourceRequest,
} from "./ListTagsOfResource.ts";

export const ListTagsOfResourceHttp = Layer.effect(
  ListTagsOfResource,
  Effect.gen(function* () {
    const listTagsOfResource = yield* DynamoDB.listTagsOfResource;

    return Effect.fn(function* <T extends Table>(table: T) {
      const ResourceArn = yield* table.tableArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.DynamoDB.ListTagsOfResource(${table}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["dynamodb:ListTagsOfResource"],
                  Resource: [table.tableArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.DynamoDB.ListTagsOfResource(${table.LogicalId})`)(
        function* (request?: ListTagsOfResourceRequest) {
          return yield* listTagsOfResource({
            ...request,
            ResourceArn: yield* ResourceArn,
          });
        },
      );
    });
  }),
);
