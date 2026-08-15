// The browser's typed API client, derived ENTIRELY from the shared schema
// module — no backend import, zero server bytes in the bundle. Requests
// are relative to the page origin: CloudFront routes /api/* to the backend
// Lambda before the static-asset manifest.
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import { SiteApi } from "../api.ts";

const client = HttpApiClient.make(SiteApi).pipe(
  Effect.provide(FetchHttpClient.layer),
);

export type SiteClient = Effect.Success<typeof client>["Site"];

/** Run one typed call against the Site group as a Promise. */
export const api = <A, E>(
  call: (site: SiteClient) => Effect.Effect<A, E>,
): Promise<A> =>
  Effect.runPromise(Effect.flatMap(client, (built) => call(built.Site)));
