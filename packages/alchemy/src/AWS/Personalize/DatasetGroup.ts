import * as personalize from "@distilled.cloud/aws/personalize";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { readPersonalizeTags, syncPersonalizeTags } from "./internal.ts";

export interface DatasetGroupProps {
  /**
   * Name of the dataset group. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing the name replaces the group.
   */
  name?: string;
  /**
   * ARN of an IAM role Personalize assumes to access a customer-managed KMS
   * key. Immutable — changing it replaces the group.
   */
  roleArn?: string;
  /**
   * ARN of a customer-managed KMS key used to encrypt the datasets. Immutable
   * — changing it replaces the group.
   */
  kmsKeyArn?: string;
  /**
   * The domain of a domain dataset group (`ECOMMERCE` or `VIDEO_ON_DEMAND`).
   * Omit for a custom dataset group. Immutable — changing it replaces the
   * group.
   */
  domain?: string;
  /**
   * User-defined tags for the dataset group.
   */
  tags?: Record<string, string>;
}

export interface DatasetGroup extends Resource<
  "AWS.Personalize.DatasetGroup",
  DatasetGroupProps,
  {
    /**
     * ARN of the dataset group.
     */
    datasetGroupArn: string;
    /**
     * Name of the dataset group.
     */
    name: string;
    /**
     * Dataset group status (e.g. `ACTIVE`, `CREATE PENDING`).
     */
    status: string;
    /**
     * Domain of the dataset group (`ECOMMERCE` or `VIDEO_ON_DEMAND`) when
     * it is a domain dataset group.
     */
    domain: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Amazon Personalize dataset group — the top-level container that holds the
 * datasets, solutions, and campaigns for a single use case. Creating a dataset
 * group is cheap and fast; the expensive training work lives in solutions and
 * campaigns provisioned separately.
 *
 * @resource
 * @section Creating a Dataset Group
 * @example Custom Dataset Group
 * ```typescript
 * const group = yield* Personalize.DatasetGroup("Recommendations", {});
 * ```
 *
 * @example Domain Dataset Group with Encryption
 * ```typescript
 * const group = yield* Personalize.DatasetGroup("Storefront", {
 *   domain: "ECOMMERCE",
 *   roleArn: role.roleArn,
 *   kmsKeyArn: key.keyArn,
 *   tags: { team: "growth" },
 * });
 * ```
 */
export const DatasetGroup = Resource<DatasetGroup>(
  "AWS.Personalize.DatasetGroup",
);

export const DatasetGroupProvider = () =>
  Provider.effect(
    DatasetGroup,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: DatasetGroupProps,
      ) {
        return props.name ?? (yield* createPhysicalName({ id, maxLength: 63 }));
      });

      const describe = Effect.fn(function* (datasetGroupArn: string) {
        const response = yield* personalize
          .describeDatasetGroup({ datasetGroupArn })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.datasetGroup;
      });

      /** Poll until the group reaches ACTIVE; fail fast on CREATE FAILED. */
      const waitActive = Effect.fn(function* (datasetGroupArn: string) {
        const group = yield* describe(datasetGroupArn).pipe(
          Effect.repeat({
            schedule: Schedule.max([
              Schedule.fixed("2 seconds"),
              Schedule.recurs(40),
            ]),
            until: (g) =>
              g?.status === "ACTIVE" || (g?.status ?? "").includes("FAILED"),
          }),
        );
        if (group?.status !== "ACTIVE") {
          return yield* Effect.fail(
            new Error(
              `Personalize dataset group ${datasetGroupArn} did not become ACTIVE (status: ${group?.status}, reason: ${group?.failureReason})`,
            ),
          );
        }
        return group;
      });

      /** Find an existing dataset group's ARN by its (deterministic) name. */
      const findArnByName = Effect.fn(function* (name: string) {
        const pages = yield* personalize.listDatasetGroups
          .pages({})
          .pipe(Stream.runCollect);
        return Array.from(pages)
          .flatMap((page) => page.datasetGroups ?? [])
          .find((summary) => summary.name === name)?.datasetGroupArn;
      });

      const toAttrs = (group: personalize.DatasetGroup) => ({
        datasetGroupArn: group.datasetGroupArn!,
        name: group.name!,
        status: group.status!,
        domain: group.domain,
      });

      return {
        stables: ["datasetGroupArn", "name"],

        diff: Effect.fn(function* ({ id, olds = {}, news }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (
            oldName !== newName ||
            (olds.roleArn ?? undefined) !== (news.roleArn ?? undefined) ||
            (olds.kmsKeyArn ?? undefined) !== (news.kmsKeyArn ?? undefined) ||
            (olds.domain ?? undefined) !== (news.domain ?? undefined)
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, output }) {
          if (!output?.datasetGroupArn) return undefined;
          const group = yield* describe(output.datasetGroupArn);
          if (group === undefined) return undefined;
          const attrs = toAttrs(group);
          const tags = yield* readPersonalizeTags(group.datasetGroupArn!);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news = {}, output, session }) {
          const name = yield* createName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // 1. Observe — cloud state is authoritative; output is an ARN cache.
          let group =
            output?.datasetGroupArn !== undefined
              ? yield* describe(output.datasetGroupArn)
              : undefined;

          // 2. Ensure — create if missing, then wait for ACTIVE. A crashed
          //    prior run may have left a same-named group behind with no
          //    persisted state — adopt it by name and converge.
          if (group === undefined) {
            const arn = yield* personalize
              .createDatasetGroup({
                name,
                roleArn: news.roleArn,
                kmsKeyArn: news.kmsKeyArn,
                domain: news.domain,
                tags: Object.entries(desiredTags).map(([tagKey, tagValue]) => ({
                  tagKey,
                  tagValue,
                })),
              })
              .pipe(
                Effect.map((created) => created.datasetGroupArn!),
                Effect.catchTag("ResourceAlreadyExistsException", (error) =>
                  findArnByName(name).pipe(
                    Effect.flatMap((existing) =>
                      existing === undefined
                        ? Effect.fail(error)
                        : Effect.succeed(existing),
                    ),
                  ),
                ),
              );
            group = yield* waitActive(arn);
          }

          // 3. Sync tags — diff against OBSERVED cloud tags (no-op after a
          //    fresh create; converges an adopted leftover).
          yield* syncPersonalizeTags(group.datasetGroupArn!, desiredTags);

          yield* session.note(group.datasetGroupArn!);
          return toAttrs(group);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* personalize
            .deleteDatasetGroup({ datasetGroupArn: output.datasetGroupArn })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              // Datasets/solutions still attached reject deletion; the engine
              // deletes dependents first, but tolerate the eventual-consistency
              // race.
              Effect.retry({
                while: (e) => e._tag === "ResourceInUseException",
                schedule: Schedule.max([
                  Schedule.fixed("3 seconds"),
                  Schedule.recurs(20),
                ]),
              }),
            );
          // Deletion is asynchronous (DELETE IN_PROGRESS) — wait until the
          // group is actually gone so the run leaves no lingering resources
          // (the group's auto-created event schema is removed with it).
          const remaining = yield* describe(output.datasetGroupArn).pipe(
            Effect.repeat({
              schedule: Schedule.max([
                Schedule.fixed("3 seconds"),
                Schedule.recurs(40),
              ]),
              until: (group): boolean => group === undefined,
            }),
          );
          if (remaining !== undefined) {
            return yield* Effect.fail(
              new Error(
                `Personalize dataset group ${output.datasetGroupArn} was not deleted (status: ${remaining.status})`,
              ),
            );
          }
        }),

        list: () =>
          personalize.listDatasetGroups.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) => page.datasetGroups ?? []),
            ),
            Effect.flatMap(
              Effect.forEach(
                (summary) =>
                  describe(summary.datasetGroupArn!).pipe(
                    Effect.map((g) => (g ? toAttrs(g) : undefined)),
                  ),
                { concurrency: 4 },
              ),
            ),
            Effect.map((items) => items.filter((item) => item !== undefined)),
          ),
      };
    }),
  );
