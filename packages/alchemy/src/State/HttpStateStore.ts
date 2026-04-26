import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import { StateApi } from "./HttpStateApi.ts";

import type { ReplacedResourceState, ResourceState } from "./ResourceState.ts";
import { StateStoreError, type StateService } from "./State.ts";
import { encodeState, reviveStateRecursive } from "./StateEncoding.ts";

export interface HttpStateStoreProps {
  url: string;
  /** Bearer token used to authenticate every request. */
  authToken: string;
}

export const makeHttpStateStore = ({ url, authToken }: HttpStateStoreProps) =>
  Effect.gen(function* () {
    const apiClient = yield* HttpApiClient.make(StateApi, {
      baseUrl: url,
      transformClient: HttpClient.mapRequest(
        HttpClientRequest.bearerToken(authToken),
      ),
    });
    const state = apiClient.state;

    const service: StateService = {
      listStacks: () =>
        state.listStacks().pipe(
          Effect.map((stacks) => [...stacks]),
          mapStateStoreError,
        ),
      listStages: (stack) =>
        state.listStages({ params: { stack } }).pipe(mapStateStoreError),
      list: (request) =>
        state.listResources({ params: request }).pipe(mapStateStoreError),
      get: (request) =>
        state
          .getState({
            params: {
              stack: request.stack,
              stage: request.stage,
              fqn: encodeURIComponent(request.fqn),
            },
          })
          .pipe(
            Effect.map((s) =>
              s == null
                ? undefined
                : (reviveStateRecursive(s) as ResourceState),
            ),
            mapStateStoreError,
          ),
      getReplacedResources: (request) =>
        state.getReplacedResources({ params: request }).pipe(
          Effect.map((resources) =>
            resources.map(
              (s) => reviveStateRecursive(s) as ReplacedResourceState,
            ),
          ),
          mapStateStoreError,
        ),
      set: <V extends ResourceState>(request: {
        stack: string;
        stage: string;
        fqn: string;
        value: V;
      }) =>
        state
          .setState({
            params: {
              stack: request.stack,
              stage: request.stage,
              fqn: encodeURIComponent(request.fqn),
            },
            payload: encodeState(request.value),
          })
          .pipe(
            // Server echoes the stored value, but the client already
            // has the canonical object (including any Redacted<T>
            // instances); returning the input avoids a lossy round-trip.
            Effect.map(() => request.value),
            mapStateStoreError,
          ),
      delete: (request) =>
        state
          .deleteState({
            params: {
              stack: request.stack,
              stage: request.stage,
              fqn: encodeURIComponent(request.fqn),
            },
          })
          .pipe(Effect.asVoid, mapStateStoreError),
      deleteStack: (request) =>
        state
          .deleteStack({
            params: { stack: request.stack },
            query: request.stage === undefined ? {} : { stage: request.stage },
          })
          .pipe(Effect.asVoid, mapStateStoreError),
    };
    return service;
  });

const retryTransient = <A, Err, Req>(eff: Effect.Effect<A, Err, Req>) =>
  Effect.retry(eff, {
    while: (e: any) =>
      e._tag === "HttpClientError" &&
      (e.response?.status === 500 ||
        e.response?.status === 502 ||
        // not founds are usually after the worker has just been created
        e.response?.status === 404),
    schedule: Schedule.exponential(100).pipe(
      Schedule.both(Schedule.recurs(10)),
    ),
  });

/** Collapse any client failure into a {@link StateStoreError}. */
const mapStateStoreError = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
  eff.pipe(
    retryTransient,
    Effect.catch((e: E) =>
      Effect.fail(
        new StateStoreError({
          message: e instanceof Error ? e.message : String(e),
          cause: e instanceof Error ? e : undefined,
        }),
      ),
    ),
  ) as Effect.Effect<A, StateStoreError, R>;
