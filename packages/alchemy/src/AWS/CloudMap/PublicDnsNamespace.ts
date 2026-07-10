import * as sd from "@distilled.cloud/aws/servicediscovery";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  awaitOperation,
  fetchObservedTags,
  observeNamespace,
  retryWhileResourceInUse,
  syncTags,
} from "./internal.ts";

export interface PublicDnsNamespaceProps {
  /**
   * Name of the namespace — must be a domain name you intend to serve
   * publicly (a Route 53 public hosted zone is created for it). Changing the
   * name replaces the namespace.
   * @default a generated DNS-compatible physical name
   */
  name?: string;
  /**
   * A description for the namespace.
   */
  description?: string;
  /**
   * The TTL (in seconds) of the SOA record for the namespace's Route 53
   * public hosted zone.
   */
  ttl?: number;
  /**
   * Tags to apply to the namespace. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface PublicDnsNamespace extends Resource<
  "AWS.CloudMap.PublicDnsNamespace",
  PublicDnsNamespaceProps,
  {
    namespaceId: string;
    namespaceArn: string;
    namespaceName: string;
    hostedZoneId: string | undefined;
  },
  {},
  Providers
> {}

/**
 * An AWS Cloud Map public DNS namespace — a service registry backed by a
 * Route 53 **public** hosted zone, so registered instances are discoverable
 * on the public internet via DNS as well as via the `DiscoverInstances` API.
 *
 * The hosted zone incurs standard Route 53 charges while the namespace
 * exists, and the namespace name is only useful if you control the domain.
 *
 * Namespace creation and deletion are asynchronous — the provider polls the
 * Cloud Map operations API (bounded) until they complete.
 * @resource
 * @section Creating Namespaces
 * @example Public DNS Namespace
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const namespace = yield* AWS.CloudMap.PublicDnsNamespace("PublicNamespace", {
 *   name: "discovery.example.com",
 * });
 * ```
 */
export const PublicDnsNamespace = Resource<PublicDnsNamespace>(
  "AWS.CloudMap.PublicDnsNamespace",
);

export const PublicDnsNamespaceProvider = () =>
  Provider.effect(
    PublicDnsNamespace,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { name?: string | undefined },
      ) {
        return (
          props.name ??
          (yield* createPhysicalName({ id, maxLength: 253, lowercase: true }))
        );
      });

      const toAttributes = (namespace: sd.Namespace) => ({
        namespaceId: namespace.Id!,
        namespaceArn: namespace.Arn!,
        namespaceName: namespace.Name!,
        hostedZoneId: namespace.Properties?.DnsProperties?.HostedZoneId,
      });

      return PublicDnsNamespace.Provider.of({
        stables: ["namespaceId", "namespaceArn", "namespaceName"],

        list: () =>
          Effect.gen(function* () {
            const pages = yield* sd.listNamespaces
              .pages({
                Filters: [
                  { Name: "TYPE", Values: ["DNS_PUBLIC"], Condition: "EQ" },
                ],
              })
              .pipe(Stream.runCollect);
            return Array.from(pages)
              .flatMap((page) => page.Namespaces ?? [])
              .filter(
                (n) =>
                  n.Id !== undefined &&
                  n.Arn !== undefined &&
                  n.Name !== undefined,
              )
              .map((n) => ({
                namespaceId: n.Id!,
                namespaceArn: n.Arn!,
                namespaceName: n.Name!,
                hostedZoneId: n.Properties?.DnsProperties?.HostedZoneId,
              }));
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.namespaceName ?? (yield* createName(id, olds ?? {}));
          const namespace = yield* observeNamespace(
            "DNS_PUBLIC",
            name,
            output?.namespaceId,
          );
          if (namespace?.Id === undefined) {
            return undefined;
          }
          const attrs = toAttributes(namespace);
          const tags = yield* fetchObservedTags(attrs.namespaceArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news = {}, olds = {} }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          // description/ttl/tags fall through to the default update path
        }),

        reconcile: Effect.fn(function* ({ id, news = {}, output, session }) {
          const name = output?.namespaceName ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE
          let namespace = yield* observeNamespace(
            "DNS_PUBLIC",
            name,
            output?.namespaceId,
          );

          // 2. ENSURE — create if missing (async operation)
          if (namespace === undefined) {
            const created = yield* sd
              .createPublicDnsNamespace({
                Name: name,
                Description: news.description,
                Properties:
                  news.ttl !== undefined
                    ? { DnsProperties: { SOA: { TTL: news.ttl } } }
                    : undefined,
                Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              })
              .pipe(
                Effect.catchTag(
                  ["NamespaceAlreadyExists", "DuplicateRequest"],
                  () => Effect.succeed({ OperationId: undefined }),
                ),
              );
            if (created.OperationId !== undefined) {
              yield* session.note(
                `creating public DNS namespace ${name} (async)...`,
              );
              yield* awaitOperation(created.OperationId);
            }
            namespace = yield* observeNamespace("DNS_PUBLIC", name, undefined);
          }
          if (namespace?.Id === undefined) {
            return yield* Effect.fail(
              new sd.NamespaceNotFound({
                Message: `namespace ${name} not visible after create`,
              }),
            );
          }

          // 3. SYNC — description + SOA TTL, observed vs desired
          const observedTtl = namespace.Properties?.DnsProperties?.SOA?.TTL;
          const descriptionDelta =
            news.description !== undefined &&
            news.description !== namespace.Description;
          const ttlDelta = news.ttl !== undefined && news.ttl !== observedTtl;
          if (descriptionDelta || ttlDelta) {
            const update = yield* sd.updatePublicDnsNamespace({
              Id: namespace.Id,
              Namespace: {
                Description: descriptionDelta ? news.description : undefined,
                Properties: ttlDelta
                  ? { DnsProperties: { SOA: { TTL: news.ttl! } } }
                  : undefined,
              },
            });
            if (update.OperationId !== undefined) {
              yield* awaitOperation(update.OperationId);
            }
          }

          // 3b. SYNC TAGS — diff against OBSERVED cloud tags
          const observedTags = yield* fetchObservedTags(namespace.Arn!);
          yield* syncTags(namespace.Arn!, observedTags, desiredTags);

          yield* session.note(namespace.Id);
          return toAttributes(namespace);
        }),

        delete: Effect.fn(function* ({ output }) {
          const deleted = yield* retryWhileResourceInUse(
            sd.deleteNamespace({ Id: output.namespaceId }),
          ).pipe(
            Effect.catchTag("NamespaceNotFound", () =>
              Effect.succeed({ OperationId: undefined }),
            ),
            // an identical delete is already in flight — await THAT operation
            // instead of silently skipping the deletion
            Effect.catchTag("DuplicateRequest", (e) =>
              Effect.succeed({ OperationId: e.DuplicateOperationId }),
            ),
          );
          if (deleted.OperationId !== undefined) {
            yield* awaitOperation(deleted.OperationId);
          }
        }),
      });
    }),
  );
