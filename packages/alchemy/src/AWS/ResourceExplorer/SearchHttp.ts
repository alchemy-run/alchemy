import * as RE2 from "@distilled.cloud/aws/resource-explorer-2";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { Search, type SearchRequest } from "./Search.ts";
import type { View } from "./View.ts";

export const SearchHttp = Layer.effect(
  Search,
  Effect.gen(function* () {
    const search = yield* RE2.search;

    return Effect.fn(function* <V extends View>(view: V) {
      const ViewArn = yield* view.viewArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.ResourceExplorer.Search(${view}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["resource-explorer-2:Search"],
                  Resource: [view.viewArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.ResourceExplorer.Search(${view.LogicalId})`)(
        function* (request: SearchRequest) {
          const viewArn = yield* ViewArn;
          return yield* search({ ...request, ViewArn: viewArn });
        },
      );
    });
  }),
);
