import * as mm from "@distilled.cloud/aws/mailmanager";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { AddressList } from "./AddressList.ts";
import { makeAddressListJobHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `ses:StartAddressListImportJob`.
 *
 * Starts a created import job once its address data has been uploaded
 * to the pre-signed URL. IAM access is granted on the bound list's ARN. Provide the implementation with
 * `Effect.provide(AWS.MailManager.StartAddressListImportJobHttp)`.
 * ### Bulk Importing Members
 * **Example:** Start an Import Job
 * ```typescript
 * const startImportJob = yield* MailManager.StartAddressListImportJob(blockList);
 *
 * // runtime
 * yield* startImportJob({ JobId });
 * ```
 *
 * @binding
 */
export interface StartAddressListImportJob extends Binding.Service<
  StartAddressListImportJob,
  "AWS.MailManager.StartAddressListImportJob",
  (
    list: AddressList,
  ) => Effect.Effect<
    (
      request: mm.StartAddressListImportJobRequest,
    ) => Effect.Effect<mm.StartAddressListImportJobResponse, mm.StartAddressListImportJobError>
  >
> {}
export const StartAddressListImportJob = Binding.Service<StartAddressListImportJob>(
  "AWS.MailManager.StartAddressListImportJob",
);

export const StartAddressListImportJobHttp = Layer.effect(
  StartAddressListImportJob,
  makeAddressListJobHttpBinding({
    tag: "AWS.MailManager.StartAddressListImportJob",
    operation: mm.startAddressListImportJob,
    actions: ["ses:StartAddressListImportJob"],
  }),
);
