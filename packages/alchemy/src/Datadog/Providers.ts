import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { ProfileLive } from "../Auth/Profile.ts";
import * as Provider from "../Provider.ts";
import { ApiLive } from "./Api.ts";
import { DatadogAuth } from "./AuthProvider.ts";
import * as Credentials from "./Credentials.ts";
import { Monitor, MonitorProvider } from "./Monitor.ts";
import {
  ServiceLevelObjective,
  ServiceLevelObjectiveProvider,
} from "./ServiceLevelObjective.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "Datadog",
) {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Datadog providers and credentials. Wires up Monitor and
 * ServiceLevelObjective resources, and registers the Datadog AuthProvider so
 * `alchemy login` can configure it.
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([Monitor, ServiceLevelObjective]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(MonitorProvider(), ServiceLevelObjectiveProvider()),
    ),
    Layer.provideMerge(ApiLive),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(DatadogAuth),
    Layer.provideMerge(ProfileLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );
