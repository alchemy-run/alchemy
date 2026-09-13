import * as ConfigProvider from "effect/ConfigProvider";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { CredentialsStore } from "../../Auth/Credentials.ts";
import { currentProfileName } from "../../Auth/Profile.ts";
import { STATE_STORE_SCRIPT_NAME } from "../../Cloudflare/StateStore/Api.ts";
import {
  CREDENTIALS_FILE,
  StoredStateStoreCredentials,
} from "../../Cloudflare/StateStore/CredentialsFile.ts";
import type { WorkerDomainConfig } from "../../Cloudflare/Workers/Worker.ts";
import type { WorkerAccessConfig } from "../../Cloudflare/Workers/WorkerAccess.ts";
import { UserFacingError } from "../../UserFacingError.ts";
import { requireDistDir } from "../Dist.ts";
import CloudflareDashboard, {
  CloudflareDashboardOptions,
  DASHBOARD_STACK_KEY,
  DASHBOARD_STAGE_KEY,
  STATE_TOKEN_KEY,
  STATE_URL_KEY,
} from "./CloudflareDashboardWorker.ts";

export {
  default as CloudflareDashboard,
  CloudflareDashboardOptions,
} from "./CloudflareDashboardWorker.ts";

/** Where the hosted dashboard reads state from, when not derived. */
export interface CloudflareStateStoreTarget {
  /** The state-store Worker's URL, e.g. `https://alchemy-state-store.<sub>.workers.dev`. */
  readonly url: string;
  /** The store's bearer token. Bound into the Worker as a secret. */
  readonly authToken: string | Redacted.Redacted<string>;
  /**
   * Script name of the state-store Worker to reach through a service
   * binding. Cloudflare blocks same-zone worker-to-worker `fetch` (error
   * 1042), so on the same account the binding is required; pass `false`
   * for a store on another zone (a custom domain on either side), where
   * plain fetch works.
   * @default "alchemy-state-store"
   */
  readonly service?: string | false;
}

export interface CloudflareDashboardProps {
  /**
   * Stack the dashboard opens with. Defaults to the first stack (sorted)
   * in the store; `?stack=` selects others per request.
   */
  readonly stack?: string;
  /**
   * Stage the dashboard opens with. Defaults to the first stage (sorted)
   * of the resolved stack; `?stage=` selects others per request.
   */
  readonly stage?: string;
  /**
   * Who may open the dashboard. It exposes everything the state store
   * holds (resource props/attrs with secrets redacted by the state
   * encoding, deployment journals, outputs), so access must be a
   * deliberate choice: Cloudflare Access policies (the Worker's `access`
   * prop — Alchemy creates the application), or `"public"` to serve it
   * to anyone with the URL.
   */
  readonly access: WorkerAccessConfig | "public";
  /** Custom domain for the dashboard Worker. */
  readonly domain?: string | WorkerDomainConfig;
  /**
   * The state store to read. Defaults to the store the CLI uses — the
   * endpoint and token `Cloudflare.state()` caches after any deploy at
   * `~/.alchemy/credentials/{profile}/cloudflare-state-store.json`.
   */
  readonly stateStore?: CloudflareStateStoreTarget;
  /**
   * Directory of the built SPA to upload. Defaults to the `dist/` of the
   * installed `@alchemy.run/dashboard` package (or `ALCHEMY_DASHBOARD_DIST`).
   */
  readonly assets?: string;
}

/**
 * No cached Cloudflare state-store credentials for the active profile:
 * the hosted dashboard cannot derive a store to read.
 */
export class DashboardStateStoreNotFound extends Data.TaggedError(
  "DashboardStateStoreNotFound",
)<{ readonly profile: string }> {
  readonly [UserFacingError] = true;
  override get message() {
    return (
      `No Cloudflare state store credentials are cached for profile '${this.profile}'. ` +
      "Deploy any stack with Cloudflare.state() first so " +
      `~/.alchemy/credentials/${this.profile}/${CREDENTIALS_FILE}.json exists, ` +
      "or pass `stateStore: { url, authToken }` explicitly."
    );
  }
}

/**
 * The state store the CLI deploys to: the endpoint + bearer token
 * `Cloudflare.state()` caches per profile. Read at deploy time, on the
 * machine running `alchemy deploy`, exactly like the state layer does.
 */
export const resolveCloudflareStateStore = Effect.gen(function* () {
  const profile = yield* currentProfileName;
  const store = yield* CredentialsStore;
  const credentials = yield* store.read(
    profile,
    CREDENTIALS_FILE,
    StoredStateStoreCredentials,
  );
  if (credentials === undefined) {
    return yield* new DashboardStateStoreNotFound({ profile });
  }
  const target: CloudflareStateStoreTarget = {
    url: credentials.url,
    authToken: credentials.authToken,
  };
  return target;
});

/**
 * Hosted alchemy dashboard on Cloudflare: one Worker serving the
 * `@alchemy.run/dashboard` SPA as static assets and the read-only viewer
 * API (`alchemy/Dashboard/Viewer`) over a deployed alchemy state store —
 * no CLI process required. Deploy it from any stack that uses
 * `Cloudflare.state()` and it shows every stack and stage in that store.
 *
 * ### Deploying the dashboard
 * **Example:** Team-only dashboard behind Cloudflare Access
 * ```typescript
 * import { Dashboard } from "alchemy/Dashboard/Hosted/Cloudflare";
 *
 * export default Alchemy.Stack(
 *   "Dashboard",
 *   { providers: Cloudflare.providers(), state: Cloudflare.state() },
 *   Effect.gen(function* () {
 *     const dashboard = yield* Dashboard({
 *       access: {
 *         policies: [
 *           { decision: "allow", include: [{ emailDomain: "example.com" }] },
 *         ],
 *       },
 *     });
 *     return { url: dashboard.url.as<string>() };
 *   }),
 * );
 * ```
 *
 * **Example:** Public dashboard pinned to one stack and stage
 * ```typescript
 * const dashboard = yield* Dashboard({
 *   access: "public",
 *   stack: "MyApp",
 *   stage: "prod",
 * });
 * ```
 *
 * ### Reading another store
 * **Example:** Explicit state store on a different zone
 * ```typescript
 * const dashboard = yield* Dashboard({
 *   access: "public",
 *   stateStore: {
 *     url: "https://state.example.com",
 *     authToken: yield* Config.redacted("STATE_TOKEN"),
 *     // cross-zone: plain fetch works, no service binding needed
 *     service: false,
 *   },
 * });
 * ```
 */
export const Dashboard = (props: CloudflareDashboardProps) =>
  Effect.gen(function* () {
    // Everything the Worker needs is resolved HERE, on the deploying
    // machine, and handed to the class through its options Reference
    // (props) and a ConfigProvider overlay (the `Config` reads its init
    // effect performs, which the deploy-time interceptor lowers into
    // secret bindings). The Worker's own module stays free of
    // credential-store and filesystem code, so its bundle is lean.
    const assets = props.assets ?? (yield* requireDistDir());
    const stateStore =
      props.stateStore ??
      (yield* resolveCloudflareStateStore.pipe(
        Effect.catchTag("DashboardStateStoreNotFound", (error) =>
          Effect.die(error),
        ),
        Effect.orDie,
      ));
    const stateService =
      stateStore.service === false
        ? undefined
        : (stateStore.service ?? STATE_STORE_SCRIPT_NAME);
    const authToken = Redacted.isRedacted(stateStore.authToken)
      ? Redacted.value(stateStore.authToken)
      : stateStore.authToken;

    const ambient = yield* ConfigProvider.ConfigProvider;
    const overlay = ConfigProvider.orElse(
      ConfigProvider.fromUnknown({
        [STATE_URL_KEY]: stateStore.url,
        [STATE_TOKEN_KEY]: authToken,
        ...(props.stack !== undefined
          ? { [DASHBOARD_STACK_KEY]: props.stack }
          : {}),
        ...(props.stage !== undefined
          ? { [DASHBOARD_STAGE_KEY]: props.stage }
          : {}),
      }),
      ambient,
    );

    return yield* CloudflareDashboard.pipe(
      Effect.provideService(CloudflareDashboardOptions, {
        assets,
        ...(props.access !== "public" ? { access: props.access } : {}),
        ...(props.domain !== undefined ? { domain: props.domain } : {}),
        ...(stateService !== undefined ? { stateService } : {}),
      }),
      Effect.provideService(ConfigProvider.ConfigProvider, overlay),
    );
  }).pipe(Effect.orDie);
