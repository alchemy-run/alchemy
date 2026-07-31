/**
 * Account-wide AppSync Events API used as the Live Lambda transport.
 *
 * Like SST's live bridge, one Event API (named `alchemy`) is shared by every
 * stack/stage in an account+region. It is bootstrap infrastructure — created
 * lazily the first time `alchemy dev` runs an AWS Function, never torn down
 * by stack destroy — so it is provisioned imperatively here rather than as a
 * stack resource.
 */
import * as appsync from "@distilled.cloud/aws/appsync";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

/** Name of the shared Event API and its channel namespace. */
export const EVENT_API_NAME = "alchemy";

export interface EventApi {
  apiId: string;
  apiArn: string;
  /** e.g. `abc123.appsync-api.us-east-1.amazonaws.com` */
  httpEndpoint: string;
  /** e.g. `abc123.appsync-realtime-api.us-east-1.amazonaws.com` */
  realtimeEndpoint: string;
}

const AUTH_MODES = [{ authType: "AWS_IAM" as const }];

const toEventApi = (api: appsync.Api): Effect.Effect<EventApi, Error> => {
  const httpEndpoint = api.dns?.HTTP;
  const realtimeEndpoint = api.dns?.REALTIME;
  if (!api.apiId || !api.apiArn || !httpEndpoint || !realtimeEndpoint) {
    return Effect.fail(
      new Error(
        `AppSync Event API "${EVENT_API_NAME}" is missing expected fields: ${JSON.stringify(api)}`,
      ),
    );
  }
  return Effect.succeed({
    apiId: api.apiId,
    apiArn: api.apiArn,
    httpEndpoint,
    realtimeEndpoint,
  });
};

/**
 * Find (or create) the shared `alchemy` Event API and its channel namespace.
 */
export const ensureEventApi = Effect.gen(function* () {
  const existing = yield* appsync.listApis.items({}).pipe(
    Stream.filter((api) => api.name === EVENT_API_NAME),
    Stream.runHead,
  );
  if (Option.isSome(existing) && existing.value.apiId) {
    // ListApis omits `dns` — hydrate through GetApi.
    const detail = yield* appsync.getApi({ apiId: existing.value.apiId });
    return yield* toEventApi(detail.api ?? existing.value);
  }

  yield* Effect.logDebug(`creating AppSync Event API "${EVENT_API_NAME}"`);
  const created = yield* appsync
    .createApi({
      name: EVENT_API_NAME,
      eventConfig: {
        authProviders: AUTH_MODES,
        connectionAuthModes: AUTH_MODES,
        defaultPublishAuthModes: AUTH_MODES,
        defaultSubscribeAuthModes: AUTH_MODES,
      },
    })
    .pipe(
      // Two dev sessions racing to create it — fall back to the winner's.
      Effect.catchTag("ConcurrentModificationException", () =>
        appsync.listApis.items({}).pipe(
          Stream.filter((api) => api.name === EVENT_API_NAME),
          Stream.runHead,
          Effect.map((api) => ({ api: Option.getOrUndefined(api) })),
        ),
      ),
    );
  if (!created.api?.apiId) {
    return yield* Effect.fail(
      new Error(`failed to create AppSync Event API "${EVENT_API_NAME}"`),
    );
  }

  yield* appsync
    .createChannelNamespace({
      apiId: created.api.apiId,
      name: EVENT_API_NAME,
      publishAuthModes: AUTH_MODES,
      subscribeAuthModes: AUTH_MODES,
    })
    .pipe(
      Effect.catchTag("ConflictException", () => Effect.succeed(undefined)),
    );

  return yield* toEventApi(created.api);
});
