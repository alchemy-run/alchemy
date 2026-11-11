import * as DO from "@distilled.cloud/digitalocean";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { ignoreNotFound } from "../internal/notFound.ts";
import type { Providers } from "../Providers.ts";

export type AccessKeyProps = {
  /** The namespace id (`fn-<uuid>`) the key authorizes. A change replaces the key. */
  namespaceId: string;
  /**
   * Key name.
   *
   * @default a generated physical name
   */
  name?: string;
};

export type AccessKey = Resource<
  "DigitalOcean.Functions.AccessKey",
  AccessKeyProps,
  {
    /** Key id, `dof_v1_…`: the user half of basic auth. */
    keyId: string;
    /** The namespace the key authorizes. */
    namespaceId: string;
    /** Key name. */
    name: string;
    /** The key's secret: the password half of basic auth. Returned only at create. */
    secret: Redacted.Redacted<string>;
  },
  never,
  Providers
>;

/**
 * A key scoped to one Functions namespace. Send `keyId:secret` as HTTP basic
 * auth to the namespace's `apiHost` to deploy or invoke its functions.
 * DigitalOcean returns the secret only at create, so Alchemy keeps it in
 * state as a `Redacted` value. `InvokeFunction` mints one per host.
 *
 * ### Creating an Access Key
 * **Example:** A key for a namespace
 * ```typescript
 * const key = yield* DigitalOcean.Functions.AccessKey("ci", {
 *   namespaceId: fns.namespaceId,
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#operation/functions_create_access_key
 *
 * @resource
 * @product Functions
 * @category Compute
 */
export const AccessKey = Resource<AccessKey>("DigitalOcean.Functions.AccessKey");

const physicalName = (id: string) => createPhysicalName({ id, lowercase: true, maxLength: 63 });

const exists = (namespaceId: string, keyId: string) =>
  DO.listFunctionsAccessKey({ namespace_id: namespaceId }).pipe(
    Effect.map((r) => (r.access_keys ?? []).some((key) => key.id === keyId)),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

export const AccessKeyProvider = () =>
  Provider.succeed(AccessKey, {
    stables: ["keyId", "namespaceId", "secret"],
    nuke: { skip: true },
    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      return (yield* exists(output.namespaceId, output.keyId)) ? output : undefined;
    }),
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (news.namespaceId !== olds.namespaceId) return { action: "replace" } as const;
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      if (output !== undefined && (yield* exists(output.namespaceId, output.keyId))) {
        return output;
      }
      const name = news.name ?? (yield* physicalName(id));
      const { access_key: key } = yield* DO.createFunctionsAccessKey({
        namespace_id: news.namespaceId,
        name,
      });
      return {
        keyId: key.id,
        namespaceId: news.namespaceId,
        name: key.name,
        secret:
          typeof key.secret === "string"
            ? Redacted.make(key.secret)
            : (key.secret ?? Redacted.make("")),
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(
        DO.deleteFunctionsAccessKey({ namespace_id: output.namespaceId, key_id: output.keyId }),
      );
    }),
  });
