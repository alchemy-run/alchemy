import * as mongodb from "@distilled.cloud/stackit/mongodb_flex";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListSuggestedIndexes } from "./ListSuggestedIndexes.ts";

/**
 * HTTP implementation of {@link ListSuggestedIndexes}.
 *
 * @layer
 * @provides Stackit.MongoDBFlex.ListSuggestedIndexes
 */
export const ListSuggestedIndexesHttp = Layer.effect(
  ListSuggestedIndexes,
  makeInstanceHttpBinding({
    tag: "Stackit.MongoDBFlex.ListSuggestedIndexes",
    access: { permissions: ["mongodb-flex.advisor.list"] },
    operation: mongodb.listSuggestedIndexes,
  }),
);
