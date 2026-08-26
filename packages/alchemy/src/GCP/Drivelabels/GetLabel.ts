import type * as drivelabels from "@distilled.cloud/gcp/drivelabels_v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Label } from "./Label.ts";

export interface GetLabelRequest extends Omit<
  drivelabels.GetLabelsRequest,
  "name"
> {}

/**
 * Runtime binding for Drive Labels `labels.get`.
 *
 * Bind this operation to a {@link Label} in a Function/Action init
 * phase. Provide {@link GetLabelHttp}.
 *
 * ### Reading Labels
 * **Example:** Read label metadata
 * ```typescript
 * const getLabel = yield* GCP.Drivelabels.GetLabel(label);
 * const metadata = yield* getLabel({ view: "LABEL_VIEW_FULL" });
 * ```
 *
 * @binding
 * @product GCP
 * @category Drivelabels
 */
export interface GetLabel extends Binding.Service<
  GetLabel,
  "GCP.Drivelabels.GetLabel",
  (
    label: Label,
  ) => Effect.Effect<
    (
      request?: GetLabelRequest,
    ) => Effect.Effect<
      drivelabels.GoogleAppsDriveLabelsV2Label,
      drivelabels.GetLabelsError,
      RuntimeContext
    >
  >
> {}

export const GetLabel = Binding.Service<GetLabel>("GCP.Drivelabels.GetLabel");
