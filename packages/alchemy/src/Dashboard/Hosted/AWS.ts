import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

import { AWSEnvironment } from "../../AWS/Environment.ts";
import { createStateBucketName } from "../../AWS/StateStore/State.ts";
import { Router } from "../../AWS/Website/Router.ts";
import type { WebsiteStandaloneDomainProps } from "../../AWS/Website/shared.ts";
import { StaticSite } from "../../AWS/Website/StaticSite.ts";
import * as Namespace from "../../Namespace.ts";
import { requireDistDir } from "../Dist.ts";
import AWSDashboard, {
  DASHBOARD_STACK_KEY,
  DASHBOARD_STAGE_KEY,
  STATE_ACCOUNT_ID_KEY,
  STATE_BUCKET_KEY,
  STATE_PREFIX_KEY,
} from "./AWSDashboardFunction.ts";

export { default as AWSDashboard } from "./AWSDashboardFunction.ts";

export interface AWSDashboardProps {
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
   * The S3 state store to read. Defaults to the account-regional bucket
   * `AWS.state()` uses (`alchemy-state-{account}-{region}-an`, bucket
   * root) for the deploying account and region.
   */
  readonly stateStore?: {
    /** Bucket holding the state objects. */
    readonly bucketName?: string;
    /** Key prefix within the bucket, e.g. `"alchemy"`. */
    readonly prefix?: string;
  };
  /**
   * Custom domain for the dashboard's CloudFront distribution (a Route 53
   * hosted zone name, or the full standalone-domain props).
   */
  readonly domain?: string | WebsiteStandaloneDomainProps;
  /**
   * Directory of the built SPA to upload. Defaults to the `dist/` of the
   * installed `@alchemy.run/dashboard` package (or `ALCHEMY_DASHBOARD_DIST`).
   */
  readonly assets?: string;
}

/**
 * Hosted alchemy dashboard on AWS: the `@alchemy.run/dashboard` SPA on
 * S3 + CloudFront, with `/api/*` routed to a Lambda serving the read-only
 * viewer API (`alchemy/Dashboard/Viewer`) straight from the S3 state
 * store — no CLI process required. The Lambda's execution role is the only
 * credential: it gets read access to the state bucket and `kms:Decrypt`
 * for the store's envelope-encrypted secrets.
 *
 * The dashboard URL is public: CloudFront has no built-in login, so put
 * the distribution behind your own gate (a WAF rule, Lambda@Edge auth, a
 * VPN) before sharing it. It exposes everything the state store holds
 * (resource props/attrs with secrets redacted by the state encoding,
 * deployment journals, outputs).
 *
 * Lambda Function URLs buffer responses, so the viewer serves its live
 * stream as snapshot polling (`sse: "poll"`) — the browser reconnects
 * every few seconds instead of holding one open stream.
 *
 * ### Deploying the dashboard
 * **Example:** Dashboard over the account's default state bucket
 * ```typescript
 * import { Dashboard } from "alchemy/Dashboard/Hosted/AWS";
 *
 * export default Alchemy.Stack(
 *   "Dashboard",
 *   { providers: AWS.providers(), state: AWS.state() },
 *   Effect.gen(function* () {
 *     const dashboard = yield* Dashboard("Dashboard");
 *     return { url: dashboard.url };
 *   }),
 * );
 * ```
 *
 * **Example:** Pinned to one stack and stage, on a custom domain
 * ```typescript
 * const dashboard = yield* Dashboard("Dashboard", {
 *   stack: "MyApp",
 *   stage: "prod",
 *   domain: { name: "dashboard.example.com", hostedZoneId },
 * });
 * ```
 *
 * ### Reading another store
 * **Example:** Explicit bucket and prefix
 * ```typescript
 * const dashboard = yield* Dashboard("Dashboard", {
 *   stateStore: { bucketName: "my-company-state", prefix: "alchemy" },
 * });
 * ```
 */
export const Dashboard = (id: string, props: AWSDashboardProps = {}) =>
  Effect.gen(function* () {
    const assets = props.assets ?? (yield* requireDistDir());
    // The bucket is pinned HERE, on the deploying machine, so the Lambda's
    // IAM grant names exactly one bucket and never has to derive it.
    const { accountId, region } = yield* AWSEnvironment.current;
    const bucketName =
      props.stateStore?.bucketName ?? createStateBucketName(accountId, region);

    const ambient = yield* ConfigProvider.ConfigProvider;
    const overlay = ConfigProvider.orElse(
      ConfigProvider.fromUnknown({
        [STATE_BUCKET_KEY]: bucketName,
        [STATE_ACCOUNT_ID_KEY]: accountId,
        ...(props.stateStore?.prefix !== undefined
          ? { [STATE_PREFIX_KEY]: props.stateStore.prefix }
          : {}),
        ...(props.stack !== undefined
          ? { [DASHBOARD_STACK_KEY]: props.stack }
          : {}),
        ...(props.stage !== undefined
          ? { [DASHBOARD_STAGE_KEY]: props.stage }
          : {}),
      }),
      ambient,
    );
    const api = yield* AWSDashboard.pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, overlay),
    );

    // One CloudFront distribution: `/api/*` to the viewer Lambda, every
    // other path to the SPA assets — same-origin, exactly like the
    // Cloudflare variant.
    const router = yield* Router("Router", {
      routes: {
        "/api/*": { url: api.functionUrl.as<string>() },
      },
      ...(props.domain !== undefined ? { domain: props.domain } : {}),
    });
    const site = yield* StaticSite("Site", {
      path: assets,
      spa: true,
      domain: { router },
    });

    return {
      /** The dashboard's URL (the distribution's default or custom domain). */
      url: router.url,
      /** The viewer API's Function URL (also routed under `{url}/api/*`). */
      apiUrl: api.functionUrl.as<string>(),
      function: api,
      router,
      site,
    };
  }).pipe(Namespace.push(id), Effect.orDie);
