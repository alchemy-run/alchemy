import * as DO from "@distilled.cloud/digitalocean";
import type { Key as ApiKey } from "@distilled.cloud/digitalocean";
import { Unowned } from "alchemy/AdoptPolicy";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { ignoreNotFound } from "../internal/notFound.ts";
import type { Providers } from "../Providers.ts";

export type KeyPermission = "read" | "readwrite" | "fullaccess";

export type KeyGrant = {
  /** Bucket the grant covers. Use `""` with `"fullaccess"` for every bucket. */
  bucket: string;
  /** What the key may do in the bucket. */
  permission: KeyPermission;
};

export type KeyProps = {
  /**
   * Display name. A change renames the key in place.
   *
   * @default a generated physical name
   */
  name?: string;
  /** Buckets the key reaches and how. A change updates the key in place. */
  grants: KeyGrant[];
};

export type Key = Resource<
  "DigitalOcean.Spaces.Key",
  KeyProps,
  {
    /** Access key id. */
    accessKeyId: string;
    /** Secret access key. DigitalOcean returns it only when the key is created. */
    secretAccessKey: Redacted.Redacted<string>;
    /** Display name. */
    name: string;
    /** Buckets the key reaches. */
    grants: KeyGrant[];
    /** ISO 8601 creation time. */
    createdAt: string;
  },
  never,
  Providers
>;

export type KeyAttributes = Key["Attributes"];

/**
 * A Spaces access key: an S3 access key id and secret scoped to buckets.
 * Give one to a runtime or a tool that reads and writes Spaces through the
 * S3 API. `name` and `grants` update in place.
 *
 * DigitalOcean returns the secret only when the key is created, so Alchemy
 * keeps it in state as a `Redacted` value. A key whose state is lost cannot
 * be recovered; Alchemy finds a generated-name key again and replaces it.
 *
 * ### Scoped Keys
 * **Example:** A read-write key for one bucket
 * ```typescript
 * const uploads = yield* DigitalOcean.Spaces.Bucket("uploads", { region: "nyc3" });
 * const key = yield* DigitalOcean.Spaces.Key("uploads-key", {
 *   grants: [{ bucket: uploads.bucketName, permission: "readwrite" }],
 * });
 * // key.accessKeyId and key.secretAccessKey sign S3 requests to uploads.endpoint.
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/Spaces-Keys
 *
 * @resource
 * @product Spaces
 * @category Storage
 */
export const Key = Resource<Key>("DigitalOcean.Spaces.Key");

// Spaces key names are 3 to 128 characters.
const NAME_MAX_LENGTH = 128;

const PAGE_SIZE = 200;

const physicalName = (id: string) => createPhysicalName({ id, maxLength: NAME_MAX_LENGTH });

const allKeys = DO.listSpacesKey.items({ per_page: PAGE_SIZE });

const observeByAccessKey = (accessKeyId: string) =>
  allKeys.pipe(
    Stream.filter((key) => key.access_key === accessKeyId),
    Stream.runHead,
  );

const observeByName = (name: string) =>
  allKeys.pipe(
    Stream.filter((key) => key.name === name),
    Stream.runHead,
  );

const grantsOf = (key: ApiKey): KeyGrant[] =>
  (key.grants ?? []).map((grant) => ({
    bucket: grant.bucket,
    permission: grant.permission as KeyPermission,
  }));

const sameGrants = (a: ReadonlyArray<KeyGrant>, b: ReadonlyArray<KeyGrant>) => {
  const fingerprint = (grants: ReadonlyArray<KeyGrant>) =>
    grants
      .map((grant) => `${grant.bucket}\0${grant.permission}`)
      .sort()
      .join("\n");
  return fingerprint(a) === fingerprint(b);
};

export const KeyProvider = () =>
  Provider.succeed(Key, {
    stables: ["accessKeyId", "secretAccessKey", "createdAt"],
    // A key carries no ownership marker.
    nuke: { skip: true },
    read: Effect.fn(function* ({ olds, output }) {
      if (output !== undefined) {
        const observed = yield* observeByAccessKey(output.accessKeyId);
        return Option.match(observed, {
          onNone: () => undefined,
          onSome: (key) => ({
            ...output,
            name: key.name ?? output.name,
            grants: grantsOf(key),
          }),
        });
      }
      // Without state the secret is gone, so a key found by name cannot be
      // used; report a chosen name as foreign and a generated one as missing.
      if (olds.name === undefined) return undefined;
      const named = yield* observeByName(olds.name);
      return Option.match(named, {
        onNone: () => undefined,
        onSome: (key) =>
          Unowned({
            accessKeyId: key.access_key ?? "",
            secretAccessKey: Redacted.make(""),
            name: key.name ?? olds.name ?? "",
            grants: grantsOf(key),
            createdAt: key.created_at ?? "",
          }),
      });
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name = news.name ?? (yield* physicalName(id));
      const observed =
        output === undefined ? Option.none() : yield* observeByAccessKey(output.accessKeyId);
      if (Option.isNone(observed) || output === undefined) {
        const { key } = yield* DO.createSpacesKey({ name, grants: news.grants });
        return {
          accessKeyId: key.access_key,
          secretAccessKey:
            typeof key.secret_key === "string" ? Redacted.make(key.secret_key) : key.secret_key,
          name: key.name,
          grants: grantsOf(key),
          createdAt: key.created_at,
        };
      }
      const key = observed.value;
      if (key.name !== name || !sameGrants(grantsOf(key), news.grants)) {
        yield* DO.updateSpacesKey({ access_key: output.accessKeyId, name, grants: news.grants });
      }
      return { ...output, name, grants: news.grants };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(DO.deleteSpacesKey({ access_key: output.accessKeyId }));
    }),
  });
