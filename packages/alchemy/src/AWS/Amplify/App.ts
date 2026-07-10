import * as amplify from "@distilled.cloud/aws/amplify";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  diffTags,
  hasAlchemyTags,
  tagRecord,
} from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

/**
 * Hosting platform for the Amplify app. `WEB` = static site, `WEB_DYNAMIC` =
 * server-side rendered, `WEB_COMPUTE` = SSR with compute (Next.js 12+).
 */
export type Platform = "WEB" | "WEB_DYNAMIC" | "WEB_COMPUTE";

/**
 * A URL redirect/rewrite rule for the Amplify app.
 */
export interface CustomRule {
  /** Source URL pattern. */
  source: string;
  /** Target URL. */
  target: string;
  /** HTTP status / rule type (e.g. `"200"`, `"301"`, `"404"`). */
  status?: string;
  /** Condition (e.g. country code) for the rule to apply. */
  condition?: string;
}

export interface AppProps {
  /**
   * Name of the app. If omitted, a unique name is generated.
   */
  name?: string;
  /**
   * Description of the app.
   */
  description?: string;
  /**
   * Hosting platform.
   * @default "WEB"
   */
  platform?: Platform;
  /**
   * Environment variables available to the build.
   */
  environmentVariables?: Record<string, string>;
  /**
   * Build specification (amplify.yml contents) for the app.
   */
  buildSpec?: string;
  /**
   * URL redirect and rewrite rules.
   */
  customRules?: CustomRule[];
  /**
   * User-defined tags to apply to the app.
   */
  tags?: Record<string, string>;
}

export interface App extends Resource<
  "AWS.Amplify.App",
  AppProps,
  {
    appId: string;
    appArn: string;
    name: string;
    platform: Platform;
    defaultDomain: string;
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An AWS Amplify Hosting app. This resource provisions the app container; it
 * does **not** connect a Git repository.
 *
 * Connecting a repository requires an OAuth handshake (via CodeConnections or a
 * personal access token) that is inherently human-in-the-loop and cannot be
 * automated from infrastructure code. To wire a repo, create the app with this
 * resource, then connect the repository and create branches from the Amplify
 * console or CLI. For a fully code-driven static/SSR site on AWS, prefer
 * Alchemy's own `Website` composites (S3 + CloudFront).
 *
 * @resource
 * @section Creating Amplify Apps
 * @example Basic App
 * ```typescript
 * const app = yield* App("MyApp", {
 *   description: "Marketing site",
 *   platform: "WEB",
 * });
 * ```
 *
 * @example App with Build Config and Redirects
 * ```typescript
 * const app = yield* App("MyApp", {
 *   platform: "WEB_COMPUTE",
 *   environmentVariables: { NODE_ENV: "production" },
 *   customRules: [
 *     { source: "/<*>", target: "/index.html", status: "404-200" },
 *   ],
 *   buildSpec: "version: 1\nfrontend:\n  phases:\n    build:\n      commands: []\n",
 * });
 * ```
 */
export const App = Resource<App>("AWS.Amplify.App");

export const AppProvider = () =>
  Provider.effect(
    App,
    Effect.gen(function* () {
      const toName = (id: string, props: { name?: string } = {}) =>
        props.name
          ? Effect.succeed(props.name)
          : createPhysicalName({ id, maxLength: 100 });

      const observe = (appId: string) =>
        amplify.getApp({ appId }).pipe(
          Effect.map((r) => r.app),
          Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
        );

      const syncTags = Effect.fn(function* (
        appArn: string,
        desiredTags: Record<string, string>,
        observedTags: Record<string, string>,
      ) {
        const { removed, upsert } = diffTags(observedTags, desiredTags);
        if (upsert.length > 0) {
          yield* amplify.tagResource({
            resourceArn: appArn,
            tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
          });
        }
        if (removed.length > 0) {
          yield* amplify.untagResource({
            resourceArn: appArn,
            tagKeys: removed,
          });
        }
      });

      return {
        stables: ["appId", "appArn"],
        read: Effect.fn(function* ({ id, output }) {
          if (!output?.appId) return undefined;
          const app = yield* observe(output.appId);
          if (!app) return undefined;
          const attrs = {
            appId: app.appId,
            appArn: app.appArn,
            name: app.name,
            platform: (app.platform as Platform) ?? "WEB",
            defaultDomain: app.defaultDomain ?? "",
            tags: tagRecord(app.tags),
          };
          return (yield* hasAlchemyTags(id, app.tags)) ? attrs : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* toName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          let app = output?.appId ? yield* observe(output.appId) : undefined;

          if (!app) {
            const created = yield* amplify.createApp({
              name,
              description: news.description,
              platform: news.platform ?? "WEB",
              environmentVariables: news.environmentVariables,
              buildSpec: news.buildSpec,
              customRules: news.customRules,
              tags: desiredTags,
            });
            app = created.app;
          } else {
            yield* amplify.updateApp({
              appId: app.appId,
              name,
              description: news.description,
              platform: news.platform ?? "WEB",
              environmentVariables: news.environmentVariables,
              buildSpec: news.buildSpec,
              customRules: news.customRules,
            });
            yield* syncTags(app.appArn, desiredTags, tagRecord(app.tags));
          }

          yield* session.note(app.appArn);
          return {
            appId: app.appId,
            appArn: app.appArn,
            name,
            platform: (news.platform as Platform) ?? "WEB",
            defaultDomain: app.defaultDomain ?? "",
            tags: desiredTags,
          };
        }),
        list: () =>
          Effect.gen(function* () {
            const apps = yield* amplify.listApps.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) => page.apps ?? []),
              ),
            );
            return apps.map((app) => ({
              appId: app.appId,
              appArn: app.appArn,
              name: app.name,
              platform: (app.platform as Platform) ?? "WEB",
              defaultDomain: app.defaultDomain,
              tags: tagRecord(app.tags),
            }));
          }),
        delete: Effect.fn(function* ({ output }) {
          yield* amplify
            .deleteApp({ appId: output.appId })
            .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
        }),
      };
    }),
  );
