import * as mongodb from "@distilled.cloud/stackit/mongodb_flex";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListAdvisorSlowQueries } from "./ListAdvisorSlowQueries.ts";

/**
 * HTTP implementation of {@link ListAdvisorSlowQueries}.
 *
 * @layer
 * @provides Stackit.MongoDBFlex.ListAdvisorSlowQueries
 */
export const ListAdvisorSlowQueriesHttp = Layer.effect(
  ListAdvisorSlowQueries,
  makeInstanceHttpBinding({
    tag: "Stackit.MongoDBFlex.ListAdvisorSlowQueries",
    access: { permissions: ["mongodb-flex.advisor.list"] },
    operation: mongodb.listAdvisorSlowQueries,
  }),
);
