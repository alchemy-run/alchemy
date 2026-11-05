import * as personalize from "@distilled.cloud/aws/personalize";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makePersonalizeAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `personalize:CreateCampaign` — Deploys a trained solution version as a live campaign that serves
 * real-time recommendations — the final step of the MLOps loop.
 * Provide the implementation with
 * `Effect.provide(AWS.Personalize.CreateCampaignHttp)`.
 *
 * ### Retraining Loop
 * **Example:** Deploy a Campaign
 * ```typescript
 * // init
 * const createCampaign = yield* Personalize.CreateCampaign();
 *
 * const { campaignArn } = yield* createCampaign({
 *   name: "recommendations",
 *   solutionVersionArn,
 * });
 * ```
 *
 * @binding
 */
export interface CreateCampaign extends Binding.Service<
  CreateCampaign,
  "AWS.Personalize.CreateCampaign",
  () => Effect.Effect<
    (
      request: personalize.CreateCampaignRequest,
    ) => Effect.Effect<personalize.CreateCampaignResponse, personalize.CreateCampaignError>
  >
> {}
export const CreateCampaign = Binding.Service<CreateCampaign>("AWS.Personalize.CreateCampaign");

export const CreateCampaignHttp = Layer.effect(
  CreateCampaign,
  makePersonalizeAccountHttpBinding({
    tag: "AWS.Personalize.CreateCampaign",
    operation: personalize.createCampaign,
    actions: ["personalize:CreateCampaign"],
  }),
);
