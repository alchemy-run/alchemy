import * as codeconnections from "@distilled.cloud/aws/codeconnections";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

export interface ConnectionProps {
  /**
   * Name of the connection (1-32 chars). If omitted a deterministic
   * physical name is generated. Changing the name replaces the connection.
   */
  connectionName?: string;
  /**
   * Source-provider the connection authenticates against. Changing the
   * provider replaces the connection.
   */
  providerType:
    | "GitHub"
    | "GitHubEnterpriseServer"
    | "Bitbucket"
    | "GitLab"
    | "GitLabSelfManaged";
  /**
   * ARN of a CodeConnections `Host` (required for self-managed providers
   * such as `GitHubEnterpriseServer` / `GitLabSelfManaged`).
   */
  hostArn?: string;
  /**
   * User-defined tags.
   */
  tags?: Record<string, string>;
}

export interface Connection extends Resource<
  "AWS.CodeConnections.Connection",
  ConnectionProps,
  {
    connectionName: string;
    connectionArn: string;
    /**
     * Connection state. A freshly created connection is `PENDING` until the
     * OAuth handshake is completed manually in the AWS console; it then
     * becomes `AVAILABLE`.
     */
    connectionStatus: string;
    providerType: string;
  },
  never,
  Providers
> {}

/**
 * An AWS CodeConnections connection to a source-code provider (GitHub,
 * GitLab, Bitbucket).
 *
 * A connection is created in the `PENDING` state. Completing it requires a
 * one-time OAuth handshake performed **manually** in the AWS console (the
 * "Update pending connection" flow) — there is no API to finish the
 * handshake. Once completed the connection becomes `AVAILABLE` and can be
 * referenced by a CodePipeline `CodeStarSourceConnection` action.
 * @resource
 * @section Creating a Connection
 * @example GitHub Connection (created PENDING)
 * ```typescript
 * const connection = yield* CodeConnections.Connection("GitHub", {
 *   providerType: "GitHub",
 * });
 * // connection.connectionStatus === "PENDING"
 * // Complete the handshake in the console before using it in a pipeline.
 * ```
 */
export const Connection = Resource<Connection>(
  "AWS.CodeConnections.Connection",
);

/** Convert a CodeConnections wire tag list into a plain record. */
const toTagRecord = (
  tags: ReadonlyArray<{ Key?: string; Value?: string }> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    (tags ?? [])
      .filter(
        (tag): tag is { Key: string; Value: string } =>
          typeof tag.Key === "string" && typeof tag.Value === "string",
      )
      .map((tag) => [tag.Key, tag.Value]),
  );

export const ConnectionProvider = () =>
  Provider.effect(
    Connection,
    Effect.gen(function* () {
      const toName = (id: string, props: Partial<ConnectionProps>) =>
        props.connectionName
          ? Effect.succeed(props.connectionName)
          : createPhysicalName({ id, maxLength: 32 });

      /** Read a connection by ARN; a missing connection reads as absent. */
      const getByArn = Effect.fn(function* (arn: string) {
        const response = yield* codeconnections
          .getConnection({ ConnectionArn: arn })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.Connection;
      });

      /** Find a connection by name (getConnection only accepts an ARN). */
      const findByName = Effect.fn(function* (name: string) {
        const connections = yield* codeconnections.listConnections
          .pages({})
          .pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) => page.Connections ?? []),
            ),
          );
        return connections.find((c) => c.ConnectionName === name);
      });

      const toAttrs = (
        connection: codeconnections.Connection,
        name: string,
      ) => ({
        connectionName: connection.ConnectionName ?? name,
        connectionArn: connection.ConnectionArn!,
        connectionStatus: connection.ConnectionStatus ?? "PENDING",
        providerType: connection.ProviderType ?? "",
      });

      const syncTags = Effect.fn(function* (
        arn: string,
        desiredTags: Record<string, string>,
      ) {
        const observed = yield* codeconnections
          .listTagsForResource({ ResourceArn: arn })
          .pipe(Effect.catch(() => Effect.succeed(undefined)));
        const { removed, upsert } = diffTags(
          toTagRecord(observed?.Tags),
          desiredTags,
        );
        if (upsert.length > 0) {
          yield* codeconnections.tagResource({
            ResourceArn: arn,
            Tags: upsert,
          });
        }
        if (removed.length > 0) {
          yield* codeconnections.untagResource({
            ResourceArn: arn,
            TagKeys: removed,
          });
        }
      });

      return {
        stables: ["connectionName", "connectionArn", "providerType"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toName(id, olds ?? {})) !== (yield* toName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
          // Provider type and host are immutable — replace on change.
          if (
            (news?.providerType ?? undefined) !==
              (olds?.providerType ?? undefined) ||
            (news?.hostArn ?? undefined) !== (olds?.hostArn ?? undefined)
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.connectionName ?? (yield* toName(id, olds ?? {}));
          const connection = output?.connectionArn
            ? yield* getByArn(output.connectionArn)
            : yield* findByName(name);
          if (connection?.ConnectionArn === undefined) return undefined;
          const attrs = toAttrs(connection, name);
          const tags = yield* codeconnections
            .listTagsForResource({ ResourceArn: attrs.connectionArn })
            .pipe(
              Effect.map((res) => toTagRecord(res.Tags)),
              Effect.catch(() => Effect.succeed({})),
            );
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.connectionName ?? (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // 1. Observe — cloud state is authoritative.
          let observed = output?.connectionArn
            ? yield* getByArn(output.connectionArn)
            : yield* findByName(name);

          // 2. Ensure — connections are immutable; create if missing. The
          // connection is created in PENDING and its OAuth handshake is
          // completed manually.
          if (observed?.ConnectionArn === undefined) {
            const created = yield* codeconnections.createConnection({
              ConnectionName: name,
              ProviderType: news.providerType,
              HostArn: news.hostArn,
              Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                Key,
                Value,
              })),
            });
            observed = yield* getByArn(created.ConnectionArn);
            if (observed?.ConnectionArn === undefined) {
              observed = {
                ConnectionName: name,
                ConnectionArn: created.ConnectionArn,
                ProviderType: news.providerType,
                ConnectionStatus: "PENDING",
              };
            }
          }

          // 3. Sync tags — diff against OBSERVED cloud tags.
          yield* syncTags(observed.ConnectionArn!, desiredTags);

          // 4. Return fresh attributes.
          yield* session.note(name);
          return toAttrs(observed, name);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* codeconnections
            .deleteConnection({ ConnectionArn: output.connectionArn })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),

        list: () =>
          codeconnections.listConnections.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk)
                .flatMap((page) => page.Connections ?? [])
                .flatMap((c) =>
                  c.ConnectionArn !== undefined
                    ? [
                        {
                          connectionName: c.ConnectionName ?? "",
                          connectionArn: c.ConnectionArn,
                          connectionStatus: c.ConnectionStatus ?? "PENDING",
                          providerType: c.ProviderType ?? "",
                        },
                      ]
                    : [],
                ),
            ),
          ),
      };
    }),
  );
