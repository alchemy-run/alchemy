import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as factchecktools from "@distilled.cloud/gcp/factchecktools_v1alpha1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { GetPage, type GetPageRequest } from "./GetPage.ts";
import { pageNameOf } from "./internal.ts";
import type { Page } from "./Page.ts";

/**
 * HTTP implementation of {@link GetPage}.
 *
 * @layer
 * @provides GCP.Factchecktools.GetPage
 */
export const GetPageHttp = Layer.effect(
  GetPage,
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const httpClient = yield* HttpClient.HttpClient;
    return Effect.fn(function* (page: Page) {
      const name = yield* page.name;
      return Effect.fn(`GCP.Factchecktools.GetPage(${page.LogicalId})`)(
        function* (_request: GetPageRequest) {
          return yield* factchecktools
            .getPages({
              name: pageNameOf(yield* name),
            })
            .pipe(
              Effect.provideService(Credentials, credentials),
              Effect.provideService(HttpClient.HttpClient, httpClient),
            );
        },
      );
    });
  }),
);
