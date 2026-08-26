import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as drivelabels from "@distilled.cloud/gcp/drivelabels_v2";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { GetLabel, type GetLabelRequest } from "./GetLabel.ts";
import type { Label } from "./Label.ts";

/**
 * HTTP implementation of {@link GetLabel}.
 *
 * @layer
 * @provides GCP.Drivelabels.GetLabel
 */
export const GetLabelHttp = Layer.effect(
  GetLabel,
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const httpClient = yield* HttpClient.HttpClient;
    const getLabels = yield* drivelabels.getLabels.pipe(
      Effect.provideService(Credentials, credentials),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
    return Effect.fn(function* (label: Label) {
      const name = yield* label.name;
      const useAdminAccess = yield* label.useAdminAccess;
      return Effect.fn(`GCP.Drivelabels.GetLabel(${label.LogicalId})`)(
        function* (request?: GetLabelRequest) {
          return yield* getLabels({
            view: "LABEL_VIEW_FULL",
            useAdminAccess: yield* useAdminAccess,
            ...request,
            name: yield* name,
          });
        },
      );
    });
  }),
);
