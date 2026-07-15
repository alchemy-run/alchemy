import * as kendra from "@distilled.cloud/aws/kendra";
import * as Layer from "effect/Layer";
import { toWireDays } from "../../Util/Duration.ts";
import { makeKendraIndexHttpBinding } from "./BindingHttp.ts";
import {
  UpdateQuerySuggestionsConfig,
  type UpdateQuerySuggestionsConfigRequest,
} from "./UpdateQuerySuggestionsConfig.ts";

export const UpdateQuerySuggestionsConfigHttp = Layer.effect(
  UpdateQuerySuggestionsConfig,
  makeKendraIndexHttpBinding({
    tag: "AWS.Kendra.UpdateQuerySuggestionsConfig",
    operation: kendra.updateQuerySuggestionsConfig,
    actions: ["kendra:UpdateQuerySuggestionsConfig"],
    prepare: ({
      QueryLogLookBackWindow,
      ...request
    }: UpdateQuerySuggestionsConfigRequest = {}) => ({
      ...request,
      QueryLogLookBackWindowInDays: toWireDays(QueryLogLookBackWindow),
    }),
  }),
);
