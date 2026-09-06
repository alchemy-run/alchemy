import * as hyperdrive from "@distilled.cloud/cloudflare/hyperdrive";
import * as Effect from "effect/Effect";

import * as Provider from "../../Provider.ts";
import { isResourceOfType, Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { findConfigByName, type DevOrigin } from "./Connection.ts";

export type RefProps = {
  /**
   * Cloud id of the existing Hyperdrive configuration. Takes precedence
   * over `name` when both are provided.
   */
  hyperdriveId?: string;
  /**
   * Name of the existing Hyperdrive configuration, used to look it up when
   * `hyperdriveId` is not provided.
   */
  name?: string;
  /**
   * Local development override. The Cloudflare API never returns the origin
   * credentials of an existing config, so `alchemy dev` can only emulate
   * the binding when a `dev` origin is declared here.
   */
  dev?: DevOrigin;
};

export type Ref = Resource<
  "Cloudflare.Hyperdrive.Ref",
  RefProps,
  {
    hyperdriveId: string;
    name: string;
    accountId: string;
    dev: DevOrigin | undefined;
  },
  never,
  Providers
>;

/**
 * A read-only reference to an existing Cloudflare Hyperdrive configuration.
 *
 * Binds a config created outside of Alchemy (dashboard, another stack,
 * another tool) to a Worker without ever managing its lifecycle: deploys
 * only observe the config, and destroying the stack leaves it untouched.
 * Use {@link Connection} when Alchemy should own the config.
 *
 * ### Referencing an existing config
 * **Example:** By cloud id
 * ```typescript
 * const hd = yield* Cloudflare.Hyperdrive.Ref("shared-db", {
 *   hyperdriveId: "a76a99bc342644deb02c38d66082262a",
 * });
 * ```
 *
 * **Example:** By name
 * ```typescript
 * const hd = yield* Cloudflare.Hyperdrive.Ref("shared-db", {
 *   name: "shared-mysql",
 * });
 * ```
 *
 * ### Binding to a Worker
 * **Example:** Using the referenced config inside a Worker
 * ```typescript
 * const hd = yield* Cloudflare.Hyperdrive.Connect(SharedDb);
 * const url = yield* hd.connectionString;
 * ```
 *
 * ### Local development
 * **Example:** Dev origin override
 * ```typescript
 * const hd = yield* Cloudflare.Hyperdrive.Ref("shared-db", {
 *   name: "shared-mysql",
 *   dev: {
 *     scheme: "mysql",
 *     host: "localhost",
 *     port: 3306,
 *     database: "app",
 *     user: "root",
 *     password: yield* Config.redacted("DEV_DB_PASSWORD"),
 *   },
 * });
 * ```
 *
 * @resource
 * @product Hyperdrive
 * @category Storage & Databases
 */
export const Ref = Resource<Ref>("Cloudflare.Hyperdrive.Ref");

export const isHyperdriveRef = (value: unknown): value is Ref =>
  isResourceOfType(value, "Cloudflare.Hyperdrive.Ref");

/**
 * Observe-only provider: `reconcile` resolves the referenced config from
 * the cloud and echoes it into attributes, and `delete` only drops the
 * state row — the config itself is never created, updated, or deleted.
 */
export const RefProvider = () =>
  Provider.succeed(Ref, {
    read: Effect.fn(function* ({ output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const hyperdriveId = output?.hyperdriveId ?? olds?.hyperdriveId;
      if (hyperdriveId) {
        return yield* hyperdrive.getConfig({ accountId, hyperdriveId }).pipe(
          Effect.map((config) => ({
            hyperdriveId: config.id,
            name: config.name,
            accountId,
            dev: output?.dev,
          })),
          Effect.catchTag("HyperdriveConfigNotFound", () =>
            Effect.succeed(undefined),
          ),
        );
      }
      if (olds?.name) {
        const match = yield* findConfigByName(olds.name);
        if (match) {
          return {
            hyperdriveId: match.id,
            name: match.name,
            accountId,
            dev: output?.dev,
          };
        }
      }
      return undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Resolve from `news` (not `output`) so retargeting the ref to a
      // different config is an ordinary update.
      if (news.hyperdriveId) {
        const config = yield* hyperdrive.getConfig({
          accountId,
          hyperdriveId: news.hyperdriveId,
        });
        return {
          hyperdriveId: config.id,
          name: config.name,
          accountId,
          dev: news.dev,
        };
      }
      if (news.name) {
        const match = yield* findConfigByName(news.name);
        if (!match) {
          return yield* Effect.fail(
            new Error(
              `Hyperdrive.Ref "${id}": no Hyperdrive config named "${news.name}" exists in account ${accountId}`,
            ),
          );
        }
        return {
          hyperdriveId: match.id,
          name: match.name,
          accountId,
          dev: news.dev,
        };
      }
      return yield* Effect.fail(
        new Error(
          `Hyperdrive.Ref "${id}" requires \`hyperdriveId\` or \`name\` to identify the existing config`,
        ),
      );
    }),
    delete: Effect.fn(function* () {
      // Read-only reference: the underlying config is never owned by this
      // resource, so destroy only drops the state row.
    }),
  });
