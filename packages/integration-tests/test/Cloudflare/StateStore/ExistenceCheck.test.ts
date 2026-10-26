import { Access } from "@alchemy.run/cloudflare/Access";
import * as CloudflareEnvironment from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { bootstrap, isStateStoreServing } from "@alchemy.run/cloudflare/StateStore/State";
import { describe, expect, it } from "@alchemy.run/test";
import { apiTokenCredentials, Credentials } from "@distilled.cloud/cloudflare/Credentials";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { ArtifactStore, createArtifactStore } from "alchemy/Artifacts";
import { CredentialsStore } from "alchemy/Auth/Credentials";
import { ProfileStore } from "alchemy/Auth/Profile";
import * as Interaction from "alchemy/Interaction";
import { STATE_STORE_VERSION } from "alchemy/State/HttpStateApi";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";

/**
 * A missing state store is bootstrapped, and bootstrapping over a live one
 * replaces its auth token and encryption key, leaving every entry in it
 * unreadable. So the existence check may answer "no store" only when its
 * lookups succeed and say so; a lookup that fails, such as one the
 * credentials aren't permitted to make, fails the check.
 *
 * Each case runs the check against a Cloudflare account behind a stubbed
 * fetch that records every request.
 */

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const SCRIPT = "alchemy-state-store";
const STORE_HOST = `${SCRIPT}.acme.workers.dev`;
const API = `api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}`;

const ok = (result: unknown) => Response.json({ success: true, errors: [], messages: [], result });

const apiError = (status: number, code: number, message: string) =>
  Response.json(
    { success: false, errors: [{ code, message }], messages: [], result: null },
    { status },
  );

// What a token without Workers Scripts Read gets. (Not code 10000, which the
// SDK retries as a transient authentication error.)
const forbidden = () => apiError(403, 9109, "Unauthorized to access requested resource");
const subdomain = () => ok({ subdomain: "acme" });
const workerNotFound = () => apiError(404, 10007, "This Worker does not exist on your account.");
const notFound = () => new Response("Not Found", { status: 404 });

interface AccountRoutes {
  readonly subdomain: () => Response;
  readonly version?: () => Response;
  readonly scriptSettings?: () => Response;
}

const account = (routes: AccountRoutes) => {
  const requests: Array<string> = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const { host, pathname } = new URL(request.url);
    const route = `${host}${pathname}`;
    requests.push(`${request.method} ${route}`);
    const respond =
      route === `${API}/workers/subdomain`
        ? routes.subdomain
        : route === `${API}/workers/scripts/${SCRIPT}/script-settings`
          ? routes.scriptSettings
          : route === `${STORE_HOST}/version`
            ? routes.version
            : undefined;
    return respond?.() ?? new Response(`unexpected ${request.method} ${route}`, { status: 400 });
  };
  const layer = Layer.mergeAll(
    FetchHttpClient.layer.pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch as typeof globalThis.fetch)),
    ),
    Layer.succeed(
      Credentials,
      Effect.succeed(apiTokenCredentials({ apiToken: Redacted.make("token") })),
    ),
    Layer.succeed(
      CloudflareEnvironment.CloudflareEnvironment,
      Effect.succeed({
        type: "apiToken" as const,
        apiToken: Redacted.make("token"),
        accountId: ACCOUNT_ID,
        source: { type: "env" as const },
      }),
    ),
  );
  return { requests, layer };
};

/** Run work that retries its probe until the retry budget is spent. */
const exhaustingRetries = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const fiber = yield* effect.pipe(Effect.forkChild);
    yield* TestClock.adjust("30 seconds");
    return yield* Fiber.join(fiber);
  });

describe(
  "isStateStoreServing",
  { tags: ["unit", "provider:cloudflare", "provider:cloudflare:statestore", "local"] },
  () => {
    it.effect("fails when the credentials can't read the workers.dev subdomain", () =>
      Effect.gen(function* () {
        const { layer } = account({ subdomain: forbidden });
        const error = yield* isStateStoreServing(ACCOUNT_ID, SCRIPT).pipe(
          Effect.provide(layer),
          Effect.flip,
        );
        expect(error._tag).toBe("StateStoreError");
        expect(error.message).toContain(
          `Could not determine whether Cloudflare State Store '${SCRIPT}' exists`,
        );
        expect(error.message).toContain("Unauthorized to access requested resource");
      }),
    );

    it.effect("fails when /version keeps failing", () =>
      Effect.gen(function* () {
        const { layer } = account({
          subdomain,
          version: () => new Response("Forbidden", { status: 403 }),
        });
        const error = yield* exhaustingRetries(
          isStateStoreServing(ACCOUNT_ID, SCRIPT).pipe(Effect.provide(layer), Effect.flip),
        );
        expect(error.message).toContain(
          `Could not determine whether Cloudflare State Store '${SCRIPT}' exists`,
        );
      }),
    );

    it.effect("fails when the Worker lookup after a 404 is forbidden", () =>
      Effect.gen(function* () {
        const { layer } = account({ subdomain, version: notFound, scriptSettings: forbidden });
        const error = yield* exhaustingRetries(
          isStateStoreServing(ACCOUNT_ID, SCRIPT).pipe(Effect.provide(layer), Effect.flip),
        );
        expect(error.message).toContain("Unauthorized to access requested resource");
      }),
    );

    it.effect("finds no store on an account without a workers.dev subdomain", () =>
      Effect.gen(function* () {
        const { layer } = account({
          subdomain: () => apiError(404, 10007, "workers.dev subdomain not found"),
        });
        expect(yield* isStateStoreServing(ACCOUNT_ID, SCRIPT).pipe(Effect.provide(layer))).toBe(
          false,
        );
      }),
    );

    it.effect("finds no store when the Worker doesn't exist", () =>
      Effect.gen(function* () {
        const { layer } = account({
          subdomain,
          version: notFound,
          scriptSettings: workerNotFound,
        });
        expect(yield* isStateStoreServing(ACCOUNT_ID, SCRIPT).pipe(Effect.provide(layer))).toBe(
          false,
        );
      }),
    );

    it.effect("finds a store that answers /version", () =>
      Effect.gen(function* () {
        const { layer } = account({
          subdomain,
          version: () => Response.json({ version: STATE_STORE_VERSION }),
        });
        expect(yield* isStateStoreServing(ACCOUNT_ID, SCRIPT).pipe(Effect.provide(layer))).toBe(
          true,
        );
      }),
    );
  },
);

/** A service bootstrap requires but never reaches before it decides whether to deploy. */
const unreachable = <Self, Shape>(service: Context.Key<Self, Shape>) =>
  Layer.succeed(
    service,
    new Proxy(
      {},
      {
        get: (_, member) => {
          throw new Error(`bootstrap reached ${service.key}.${String(member)}`);
        },
      },
    ) as Shape,
  );

/**
 * Bootstrap from the CLI against the same accounts. The deploy itself is
 * replaced by recording the progress task it runs under.
 */
const bootstrapRecordingDeploys = (layer: ReturnType<typeof account>["layer"]) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dotAlchemy = yield* fs.makeTempDirectoryScoped();
    const tasks: Array<string> = [];
    const interaction = Layer.effect(
      Interaction.Interaction,
      Effect.gen(function* () {
        const base = yield* Interaction.Interaction;
        return {
          ...base,
          task: (options) =>
            Effect.sync(() => tasks.push(options.label)).pipe(
              Effect.andThen(Effect.die("deploy replaced by the test")),
            ),
        } satisfies Interaction.Interaction["Service"];
      }),
    ).pipe(Layer.provide(Interaction.layerNonInteractive()));
    const exit = yield* bootstrap({
      workerName: SCRIPT,
      profile: "state-store-existence-check-test",
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layer,
          interaction,
          Layer.succeed(AlchemyContext, { dotAlchemy, dev: false, adopt: false }),
          Layer.sync(ArtifactStore, createArtifactStore),
          unreachable(Access),
          unreachable(CredentialsStore),
          unreachable(ProfileStore),
          NodeServices.layer,
        ),
      ),
      Effect.exit,
    );
    return { exit, tasks };
  }).pipe(Effect.provide(NodeServices.layer));

describe(
  "bootstrap",
  { tags: ["unit", "provider:cloudflare", "provider:cloudflare:statestore", "local"] },
  () => {
    it.effect("doesn't deploy when it can't tell whether the store exists", () =>
      Effect.gen(function* () {
        const { layer, requests } = account({ subdomain: forbidden });
        const { exit, tasks } = yield* bootstrapRecordingDeploys(layer);
        expect(exit._tag).toBe("Failure");
        expect(String(exit)).toContain(
          `Could not determine whether Cloudflare State Store '${SCRIPT}' exists`,
        );
        expect(tasks).toEqual([]);
        expect(requests).toEqual([`GET ${API}/workers/subdomain`]);
      }),
    );

    it.effect("deploys a store confirmed absent", () =>
      Effect.gen(function* () {
        const { layer, requests } = account({
          subdomain,
          version: notFound,
          scriptSettings: workerNotFound,
        });
        const { tasks } = yield* bootstrapRecordingDeploys(layer);
        expect(tasks).toEqual([`Deploying Cloudflare State Store '${SCRIPT}'`]);
        expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
      }),
    );
  },
);
