import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { AuthProviders } from "../Auth/AuthProvider.ts";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { AlchemyProfile, ProfileLive } from "../Auth/Profile.ts";
import * as Provider from "../Provider.ts";
import { PlatformServices } from "../Util/PlatformServices.ts";
import { proxyChain } from "../Util/proxy-chain.ts";
import { PrismaAuth } from "./AuthProvider.ts";
import { App, AppProvider } from "./App.ts";
import { Branch, BranchProvider } from "./Branch.ts";
import { Bucket, BucketProvider } from "./Bucket.ts";
import { BucketAccessKey, BucketAccessKeyProvider } from "./BucketAccessKey.ts";
import {
  PrismaClient,
  PrismaClientLive,
  type PrismaManagementClient,
} from "./Client.ts";
import { Connection, ConnectionProvider } from "./Connection.ts";
import { Retry } from "@distilled.cloud/prisma-postgres";
import * as Credentials from "./Credentials.ts";
import { Compute, ComputeProvider } from "./Compute.ts";
import { CustomDomain, CustomDomainProvider } from "./CustomDomain.ts";
import { Database, DatabaseProvider } from "./Database.ts";
import { Deployment, DeploymentProvider } from "./Deployment.ts";
import {
  EnvironmentVariable,
  EnvironmentVariableProvider,
} from "./EnvironmentVariable.ts";
import {
  PrismaHttpClientLive,
  PrismaUploadClientLive,
} from "./Internal/HttpClient.ts";
import { fromProfile } from "./PrismaEnvironment.ts";
import { Project, ProjectProvider } from "./Project.ts";
import {
  SourceRepository,
  SourceRepositoryProvider,
} from "./SourceRepository.ts";

export { PrismaEnvironment } from "./PrismaEnvironment.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "Prisma",
) {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Standalone operation helpers own a private auth registry because they run
 * outside a Stack. Credential resolution stays eager here so constructing
 * `managementApi()` preserves its existing fail-fast behavior — which also
 * lets the distilled `Credentials` service read the already-resolved
 * {@link PrismaEnvironment} rather than building its own.
 */
const standaloneManagementApiLayer = () =>
  PrismaClientLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Credentials.fromEnvironment(),
        Layer.succeed(Retry.Retry, Retry.makeDefault),
      ),
    ),
    Layer.provideMerge(fromProfile()),
    Layer.provideMerge(PrismaAuth),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(AuthProviders, {}),
        // The Prisma-scoped upload client (node transport) rides the
        // providers' output so artifact uploads can reach it at op time.
        PrismaUploadClientLive,
        Layer.provide(ProfileLive, PlatformServices),
        Layer.provide(CredentialsStoreLive, PlatformServices),
      ),
    ),
    // Provide (NOT provideMerge) the node transport privately: it must serve
    // only the Prisma management client. Exposing it from `providers()` would
    // override the ambient HttpClient for every other provider in the stack —
    // Cloudflare Worker script uploads then go out via node:http, which
    // streams multipart bodies as `Transfer-Encoding: chunked`, and
    // api.cloudflare.com never answers chunked uploads.
    Layer.provide(PrismaHttpClientLive),
  );

/**
 * Stack provider discovery must register auth without requiring credentials.
 * The management client is resolved on its first API operation, after
 * `alchemy login` has had a chance to configure the registered Prisma auth
 * provider. The nested client layer shares the provider layer's lifetime.
 *
 * The distilled `Credentials` and `Retry` services are merged in here so the
 * auth layers below satisfy both them and the management client. The
 * transport is not: `providers()` supplies it with `Layer.provide` so it can
 * never override the ambient `HttpClient` other providers in the stack use.
 *
 * Note the retry envelope changed with the distilled migration:
 * `Retry.makeDefault` (8 retries, 250ms base, honors `Retry-After`) replaced
 * the client's 4×100ms idempotent-only policy, and creates opt out with
 * `Retry.none`.
 *
 * The hand-rolled client's client-side guards did not survive the migration:
 * its 10s request deadline, its 2-minute provisioning deadline on creates
 * and deletes, and its pagination-walk caps (deadline, page/item/byte caps,
 * repeated-cursor detection) have no distilled equivalent, so a stalled call
 * or a server that repeats a cursor is now bounded only by the transport and
 * the retry policy. Accepted for parity with the Neon provider; revisit if a
 * live run hangs here. (The one cap that did survive is the malformed-page
 * check: every walk still fails loudly on `hasMore: true` without a cursor.)
 *
 * Two more inherited deltas, both properties of distilled's shared REST
 * protocol rather than of this provider:
 *
 * - **Server error text is no longer sanitized.** The old client reduced an
 *   API error message to `HTTP {status}` or a regex-validated error code and
 *   kept the raw body `Redacted`. Distilled puts the server's `error.message`
 *   — or the raw body text — verbatim into the typed error's message, and
 *   `UnknownPrismaPostgresError` carries the whole body un-redacted, so those
 *   strings reach user-visible logs. If the API ever echoes submitted secret
 *   material back in a 4xx, it is now readable there. Re-wrapping every
 *   operation would undo the point of the migration, so the question of
 *   whether sanitization belongs in `protocol-rest` is left to distilled.
 * - **2xx bodies are no longer schema-validated.** The old client failed with
 *   a labeled `PrismaApiDecodeError` when a 2xx lacked the `{ data }`
 *   envelope; `protocol-rest` only key-maps the body, so a malformed 200
 *   yields `undefined` that either crashes later or persists into resource
 *   attributes. The dropped `Accept: application/json` and `User-Agent`
 *   request headers go with it. Per-call-site validation in alchemy is the
 *   wrong layer; this is also a distilled-side question.
 */
const stackManagementApiLayer = () =>
  Layer.effect(
    PrismaClient,
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const authProviders = yield* AuthProviders;
      const profile = yield* AlchemyProfile;
      const client = Layer.buildWithScope(
        PrismaClientLive.pipe(
          Layer.provideMerge(
            fromProfile().pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(AuthProviders, authProviders),
                  Layer.succeed(AlchemyProfile, profile),
                ),
              ),
            ),
          ),
          Layer.provide(PrismaHttpClientLive),
        ),
        scope,
      ).pipe(Effect.map((context) => Context.get(context, PrismaClient)));
      const cached = yield* Effect.cached(client);
      return proxyChain(cached) as PrismaManagementClient;
    }),
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Credentials.fromAuthProvider(),
        Layer.succeed(Retry.Retry, Retry.makeDefault),
      ),
    ),
    Layer.provideMerge(PrismaAuth),
    Layer.provideMerge(
      Layer.mergeAll(
        // The Prisma-scoped upload client (node transport) rides the
        // providers' output so artifact uploads can reach it at op time.
        PrismaUploadClientLive,
        Layer.provide(ProfileLive, PlatformServices),
        Layer.provide(CredentialsStoreLive, PlatformServices),
      ),
    ),
  );

/**
 * Build a layer for Prisma Management API operation helpers.
 *
 * Use this when calling helpers like `Prisma.listProjects()` outside an
 * Alchemy stack or test. Inside a stack (or a `test.provider` body) deployed
 * with `Prisma.providers()`, the management client is already in context, so
 * operation helpers work without providing this layer.
 *
 * @example
 * ```typescript
 * const projects = yield* Prisma.listProjects().pipe(
 *   Effect.provide(Prisma.managementApi()),
 * );
 * ```
 *
 * This layer covers the operation helpers. The lifecycle helpers
 * (`destroyApp`, `destroyDeployment`, `destroyProjectApps`,
 * `waitForDeploymentStatus`, `syncComputeEnvironment`) also need an
 * `HttpClient` from the caller, because the Prisma-scoped node transport is
 * `Layer.provide`d privately here — see the comment on the private provide
 * above for why it must not reach the surrounding stack. Add one, e.g.:
 *
 * ```typescript
 * yield* Prisma.destroyApp(appId).pipe(
 *   Effect.provide(Prisma.managementApi()),
 *   Effect.provide(FetchHttpClient.layer),
 * );
 * ```
 */
export const managementApi = () =>
  standaloneManagementApiLayer().pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.orDie,
  );

/**
 * Build a layer that registers all Prisma resource providers, the Prisma
 * auth provider, resolved credentials, and an HTTP client.
 *
 * Every resource is registered with {@link ../Local/ProviderLayer.ts
 * ProviderLayer.dual}: a **live** implementation backed by the Prisma
 * Management API and a **local** implementation used by `alchemy dev`
 * (fabricated `dev:` identifiers; `Prisma.Database` boots a local
 * `@prisma/dev` server). The engine picks the variant per run and per
 * resource:
 *
 * - `alchemy deploy` resolves the live variant; `alchemy dev` resolves the
 *   local variant automatically.
 * - Wrap a resource in `Alchemy.remote(...)` to keep it live even during
 *   `alchemy dev`.
 * - To replace implementations wholesale, construct your own layer instead
 *   of this one: register the {@link Providers} collection and provide your
 *   own per-resource provider layers (compose the exported per-resource
 *   factories like {@link ProjectProvider} with your replacements, and
 *   {@link managementApi} when live operations are needed).
 *
 * @example
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as Prisma from "alchemy/Prisma";
 * import * as Effect from "effect/Effect";
 *
 * export default Alchemy.Stack(
 *   "MyStack",
 *   { providers: Prisma.providers(), state: Alchemy.localState() },
 *   Effect.gen(function* () {
 *     const project = yield* Prisma.Project("app", {
 *       name: "app",
 *       region: "us-east-1",
 *     });
 *     return { projectId: project.projectId };
 *   }),
 * );
 * ```
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([
      Project,
      Database,
      Connection,
      Branch,
      Bucket,
      BucketAccessKey,
      Compute,
      App,
      Deployment,
      CustomDomain,
      EnvironmentVariable,
      SourceRepository,
    ]),
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        ProjectProvider(),
        DatabaseProvider(),
        ConnectionProvider(),
        BranchProvider(),
        BucketProvider(),
        BucketAccessKeyProvider(),
        ComputeProvider(),
        AppProvider(),
        DeploymentProvider(),
        CustomDomainProvider(),
        EnvironmentVariableProvider(),
        SourceRepositoryProvider(),
      ),
    ),
    // The management client layer is shared by every live variant. It is
    // built in both modes but stays inert until the first API operation:
    // auth registers without resolving credentials, so `alchemy dev` never
    // needs a Prisma token.
    Layer.provideMerge(stackManagementApiLayer()),
    Layer.provide(FetchHttpClient.layer),
    Layer.orDie,
  );
