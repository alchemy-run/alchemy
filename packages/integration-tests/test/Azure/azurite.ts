import { azuriteEndpoints } from "@alchemy.run/azure/Storage/Azurite";
import { type Credentials, fromStaticToken } from "@distilled.cloud/azure";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";

/** SAS-signed Azurite endpoints, for distilled `storage-*` calls (`{ url }`). */
export interface AzuriteUrls {
  readonly blob: string;
  readonly queue: string;
}

/**
 * Run distilled Storage calls against the local emulator, out of band of the
 * providers. A SAS-signed call never asks for a token; the static token only
 * satisfies the type.
 */
export const onAzurite = <A, E>(
  call: (urls: AzuriteUrls) => Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
) =>
  Effect.gen(function* () {
    const endpoints = yield* azuriteEndpoints;
    return yield* call({
      blob: `${endpoints.blob}?${endpoints.sas}`,
      queue: `${endpoints.queue}?${endpoints.sas}`,
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        fromStaticToken({ bearerToken: "azurite", subscriptionId: "" }),
        FetchHttpClient.layer,
      ),
    ),
  );
