import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { GreetingApi } from "../spec.ts";

const makeClient = HttpApiClient.make(GreetingApi, {
  baseUrl: import.meta.env.VITE_API_URL,
});

/** The typed client for the backend, derived from the shared `GreetingApi` spec. */
export class Api extends Context.Service<Api, Effect.Success<typeof makeClient>>()("Api") {}

/** Every Effect the UI runs gets its services from this runtime, built once per page. */
export const runtime = ManagedRuntime.make(
  Layer.effect(Api, makeClient).pipe(Layer.provide(FetchHttpClient.layer)),
);
