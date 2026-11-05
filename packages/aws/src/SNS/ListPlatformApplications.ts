import * as sns from "@distilled.cloud/aws/sns";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeSnsAccountHttpBinding } from "./BindingHttp.ts";

export interface ListPlatformApplicationsRequest extends sns.ListPlatformApplicationsInput {}

/**
 * Runtime binding for `sns:ListPlatformApplications`.
 *
 * An account-scoped operation — pages through the mobile-push platform
 * applications in the account/region.
 * Provide the `ListPlatformApplicationsHttp` layer on the Function to implement the binding.
 * ### Mobile Push
 * **Example:** List Platform Applications
 * ```typescript
 * const listApplications = yield* SNS.ListPlatformApplications();
 * const { PlatformApplications } = yield* listApplications();
 * ```
 *
 * @binding
 */
export interface ListPlatformApplications extends Binding.Service<
  ListPlatformApplications,
  "AWS.SNS.ListPlatformApplications",
  () => Effect.Effect<
    (
      request?: ListPlatformApplicationsRequest,
    ) => Effect.Effect<sns.ListPlatformApplicationsResponse, sns.ListPlatformApplicationsError>
  >
> {}

export const ListPlatformApplications = Binding.Service<ListPlatformApplications>(
  "AWS.SNS.ListPlatformApplications",
);

export const ListPlatformApplicationsHttp = Layer.effect(
  ListPlatformApplications,
  makeSnsAccountHttpBinding({
    tag: "AWS.SNS.ListPlatformApplications",
    operation: sns.listPlatformApplications,
    actions: ["sns:ListPlatformApplications"],
  }),
);
