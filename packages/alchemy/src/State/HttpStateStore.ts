import * as Effect from "effect/Effect";
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
        state.listStages({ query: { stack } }).pipe(mapStateStoreError),
      list: (request) =>
        state.listResources({ query: request }).pipe(mapStateStoreError),
      get: (request) =>
        state.getState({ query: request }).pipe(
          Effect.map((s) =>
            s == null ? undefined : (reviveStateRecursive(s) as ResourceState),
          ),
          mapStateStoreError,
        ),
      getReplacedResources: (request) =>
        state.getReplacedResources({ query: request }).pipe(
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
            payload: {
              stack: request.stack,
              stage: request.stage,
              fqn: request.fqn,
              value: encodeState(request.value),
            },
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
          .deleteState({ payload: request })
          .pipe(Effect.asVoid, mapStateStoreError),
    };
    return service;
  });

/** Collapse any client failure into a {@link StateStoreError}. */
const mapStateStoreError = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
  Effect.catch(eff, (e: E) =>
    Effect.fail(
      new StateStoreError({
        message: e instanceof Error ? e.message : String(e),
        cause: e instanceof Error ? e : undefined,
      }),
    ),
  ) as Effect.Effect<A, StateStoreError, R>;
