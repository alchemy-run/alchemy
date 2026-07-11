import * as appintegrations from "@distilled.cloud/aws/appintegrations";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { definedTags } from "./internal.ts";

export interface ApplicationProps {
  /**
   * Name of the application. If omitted, a unique name is generated from
   * the app, stage, and logical ID. The name can be updated in place.
   */
  name?: string;
  /**
   * The unique namespace of the application, e.g. `com.example.myapp`.
   * Changing the namespace replaces the application.
   */
  namespace: string;
  /**
   * Description of the application (1-1000 characters).
   */
  description?: string;
  /**
   * The URL where the application is hosted and rendered from, e.g.
   * `https://example.com`.
   */
  accessUrl: string;
  /**
   * Additional origins the application is allowed to be loaded from.
   */
  approvedOrigins?: string[];
  /**
   * The configuration of events or requests that the application has access
   * to, e.g. `["User.Details.View"]`.
   */
  permissions?: string[];
  /**
   * Tags to apply to the application. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface Application extends Resource<
  "AWS.AppIntegrations.Application",
  ApplicationProps,
  {
    applicationId: string;
    applicationArn: string;
    applicationName: string;
    namespace: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon AppIntegrations application. Applications register external
 * (iframe-hosted) apps — most commonly Amazon Connect agent workspace
 * third-party applications — with a name, namespace, and the URL they are
 * served from.
 *
 * The namespace is immutable; changing it replaces the application. The
 * name, description, access URL, approved origins, and permissions can all
 * be updated in place.
 * @resource
 * @section Creating an Application
 * @example Basic Application
 * ```typescript
 * import * as AppIntegrations from "alchemy/AWS/AppIntegrations";
 *
 * const app = yield* AppIntegrations.Application("AgentApp", {
 *   namespace: "com.example.agentapp",
 *   accessUrl: "https://example.com",
 * });
 * ```
 *
 * @example Application with Permissions and Tags
 * ```typescript
 * const app = yield* AppIntegrations.Application("AgentApp", {
 *   namespace: "com.example.agentapp",
 *   accessUrl: "https://example.com",
 *   description: "Agent workspace application",
 *   permissions: ["User.Details.View"],
 *   tags: { team: "contact-center" },
 * });
 * ```
 */
export const Application = Resource<Application>(
  "AWS.AppIntegrations.Application",
);

/**
 * Raised when the AppIntegrations API returns an application without the
 * fields required to build the resource attributes.
 */
export class ApplicationIncomplete extends Data.TaggedError(
  "AppIntegrationsApplicationIncomplete",
)<{ message: string }> {}

export const ApplicationProvider = () =>
  Provider.effect(
    Application,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { name?: string },
      ) {
        return (
          props.name ?? (yield* createPhysicalName({ id, maxLength: 255 }))
        );
      });

      /** Get a single application by ARN or ID; undefined if absent. */
      const observe = (arnOrId: string) =>
        appintegrations
          .getApplication({ Arn: arnOrId })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      /** Find an application ARN by name+namespace via list enumeration. */
      const findByName = (name: string, namespace: string) =>
        appintegrations.listApplications.items({}).pipe(
          Stream.filter(
            (item) => item.Name === name && item.Namespace === namespace,
          ),
          Stream.take(1),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)[0]?.Arn),
        );

      const toAttrs = Effect.fn(function* (
        live: appintegrations.GetApplicationResponse,
      ) {
        if (
          live.Arn === undefined ||
          live.Id === undefined ||
          live.Name === undefined ||
          live.Namespace === undefined
        ) {
          return yield* new ApplicationIncomplete({
            message: `application '${live.Name}' is missing Arn, Id, Name, or Namespace`,
          });
        }
        return {
          applicationId: live.Id,
          applicationArn: live.Arn,
          applicationName: live.Name,
          namespace: live.Namespace,
        };
      });

      return Application.Provider.of({
        stables: ["applicationId", "applicationArn", "namespace"],

        list: () =>
          appintegrations.listApplications.items({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((item) =>
                item.Arn !== undefined &&
                item.Id !== undefined &&
                item.Name !== undefined &&
                item.Namespace !== undefined
                  ? [
                      {
                        applicationId: item.Id,
                        applicationArn: item.Arn,
                        applicationName: item.Name,
                        namespace: item.Namespace,
                      },
                    ]
                  : [],
              ),
            ),
          ),

        read: Effect.fn(function* ({ id, olds, output }) {
          let arn = output?.applicationArn;
          if (arn === undefined) {
            if (olds === undefined) return undefined;
            const name = yield* createName(id, olds);
            arn = yield* findByName(name, olds.namespace);
          }
          if (arn === undefined) return undefined;
          const live = yield* observe(arn);
          if (live === undefined) return undefined;
          const attrs = yield* toAttrs(live);
          const tags = definedTags(live.Tags);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (olds === undefined) return undefined;
          if (olds.namespace !== news.namespace) {
            return { action: "replace" } as const;
          }
          // fall through: default update path (name, description, source
          // config, permissions, tags are all mutable in place)
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* createName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };
          const desiredSourceConfig: appintegrations.ApplicationSourceConfig = {
            ExternalUrlConfig: {
              AccessUrl: news.accessUrl,
              ...(news.approvedOrigins
                ? { ApprovedOrigins: news.approvedOrigins }
                : {}),
            },
          };

          // 1. Observe — prefer the cached ARN; fall back to enumerating by
          //    name+namespace so a lost-state re-run converges.
          let arn = output?.applicationArn;
          let live = arn === undefined ? undefined : yield* observe(arn);
          if (live === undefined) {
            arn = yield* findByName(name, news.namespace);
            live = arn === undefined ? undefined : yield* observe(arn);
          }

          // 2. Ensure — create if missing.
          if (live === undefined) {
            const created = yield* appintegrations.createApplication({
              Name: name,
              Namespace: news.namespace,
              Description: news.description,
              ApplicationSourceConfig: desiredSourceConfig,
              Permissions: news.permissions,
              Tags: desiredTags,
            });
            if (created.Arn === undefined) {
              return yield* new ApplicationIncomplete({
                message: `createApplication for '${name}' returned no Arn`,
              });
            }
            arn = created.Arn;
            live = yield* appintegrations.getApplication({ Arn: arn });
          }
          const attrs = yield* toAttrs(live);

          // 3. Sync mutable aspects — compare observed cloud state against
          //    desired and push a single update with only the changed fields.
          const update: Omit<appintegrations.UpdateApplicationRequest, "Arn"> =
            {};
          if (live.Name !== name) {
            update.Name = name;
          }
          if (
            news.description !== undefined &&
            news.description !== live.Description
          ) {
            update.Description = news.description;
          }
          const observedUrlConfig =
            live.ApplicationSourceConfig?.ExternalUrlConfig;
          if (
            observedUrlConfig?.AccessUrl !== news.accessUrl ||
            JSON.stringify(observedUrlConfig?.ApprovedOrigins ?? []) !==
              JSON.stringify(news.approvedOrigins ?? [])
          ) {
            update.ApplicationSourceConfig = desiredSourceConfig;
          }
          if (
            news.permissions !== undefined &&
            JSON.stringify([...(live.Permissions ?? [])].sort()) !==
              JSON.stringify([...news.permissions].sort())
          ) {
            update.Permissions = news.permissions;
          }
          if (Object.keys(update).length > 0) {
            yield* appintegrations.updateApplication({
              Arn: attrs.applicationArn,
              ...update,
            });
          }

          // 4. Sync tags — diff against OBSERVED cloud tags so adoption
          //    converges.
          const observedTags = definedTags(live.Tags);
          const { upsert, removed } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* appintegrations.tagResource({
              resourceArn: attrs.applicationArn,
              tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
            });
          }
          if (removed.length > 0) {
            yield* appintegrations.untagResource({
              resourceArn: attrs.applicationArn,
              tagKeys: removed,
            });
          }

          yield* session.note(name);
          return { ...attrs, applicationName: name };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* appintegrations
            .deleteApplication({ Arn: output.applicationArn })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );
