import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Provider from "../Provider.ts";
import * as Credentials from "./Credentials.ts";
import { Project, ProjectProvider } from "./Project.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "Sentry",
) {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Sentry providers and credentials. Credentials come from
 * `SENTRY_AUTH_TOKEN`, with `SENTRY_API_BASE_URL` selecting a self-hosted
 * instance.
 */
export const providers = () =>
  Layer.effect(Providers, Provider.collection([Project])).pipe(
    Layer.provide(Layer.mergeAll(ProjectProvider())),
    Layer.provideMerge(Credentials.fromEnv()),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.orDie,
  );
