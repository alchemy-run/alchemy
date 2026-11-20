import type * as SVC from "@distilled.cloud/aws/databrew";
import * as databrew from "@distilled.cloud/aws/databrew";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeDataBrewRecipeHttpBinding } from "./BindingHttp.ts";
import type { Recipe } from "./Recipe.ts";

export interface PublishRecipeRequest extends Omit<SVC.PublishRecipeRequest, "Name"> {}

/**
 * Runtime binding for `databrew:PublishRecipe` — snapshots the bound
 * recipe's `LATEST_WORKING` steps as the next numbered published version
 * (recipe jobs consume the latest published version by default).
 * ### Publishing Recipes
 * **Example:** Publish a New Version
 * ```typescript
 * const publishRecipe = yield* AWS.DataBrew.PublishRecipe(recipe);
 *
 * const { Name } = yield* publishRecipe({ Description: "nightly cut" });
 * ```
 *
 * @binding
 */
export interface PublishRecipe extends Binding.Service<
  PublishRecipe,
  "AWS.DataBrew.PublishRecipe",
  <R extends Recipe>(
    recipe: R,
  ) => Effect.Effect<
    (
      request?: PublishRecipeRequest,
    ) => Effect.Effect<SVC.PublishRecipeResponse, SVC.PublishRecipeError>
  >
> {}
export const PublishRecipe = Binding.Service<PublishRecipe>("AWS.DataBrew.PublishRecipe");

export const PublishRecipeHttp = Layer.effect(
  PublishRecipe,
  makeDataBrewRecipeHttpBinding({
    tag: "AWS.DataBrew.PublishRecipe",
    operation: databrew.publishRecipe,
    actions: ["databrew:PublishRecipe"],
  }),
);
