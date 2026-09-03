import {
  sshKeysCreate,
  sshKeysDelete,
  sshKeysGet,
  sshKeysList,
  sshKeysUpdate,
  type SshKeys as ApiSshKey,
} from "@distilled.cloud/digitalocean/sshKeys";
import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { OwnedBySomeoneElse, Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { ReplacementRequired } from "../../ReplacementRequired.ts";
import { Resource } from "../../Resource.ts";
import { listAllPages } from "../paginate.ts";
import { pollUntil, pollUntilGone } from "../poll.ts";
import type { Providers } from "../Providers.ts";

export type SshKeyProps = {
  /**
   * Display name for the key. Defaults to a generated physical name.
   * Renames in place.
   */
  name?: string;
  /**
   * The public key in `authorized_keys` format (`ssh-ed25519 AAAA… note`).
   * The key material is the identity — changing it replaces the resource.
   */
  publicKey: string;
};

export type SshKey = Resource<
  "DigitalOcean.SshKey",
  SshKeyProps,
  {
    sshKeyId: number;
    /** Display name. */
    name: string;
    /** MD5 fingerprint DigitalOcean derives from the key material. */
    fingerprint: string;
    /** The registered public key, verbatim. */
    publicKey: string;
  },
  never,
  Providers
>;

/**
 * An SSH public key registered on the DigitalOcean team, embedded into the
 * root account of droplets created with it. DigitalOcean derives the
 * fingerprint from `publicKey` and rejects duplicates, so the key material
 * is the identity: changing `publicKey` replaces the resource while `name`
 * updates in place.
 *
 * Ownership: a key carries no ownership markers. A registration of the
 * same key material under a different name belongs to someone else and
 * surfaces as `Unowned`, so taking it over requires `--adopt`.
 *
 * @resource
 * @product SSH Keys
 * @category Compute
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/SSH-Keys
 *
 * @section Creating an SshKey
 * @example Register a deploy key and boot a droplet with it
 * ```typescript
 * const key = yield* DigitalOcean.SshKey("deploy-key", {
 *   publicKey: process.env.SSH_PUBLIC_KEY!,
 * });
 * const host = yield* DigitalOcean.Droplet("app", {
 *   region: "sfo3",
 *   size: "s-2vcpu-4gb",
 *   image: "ubuntu-24-04-x64",
 *   sshKeys: [key.fingerprint],
 * });
 * ```
 */
export const SshKey = Resource<SshKey>("DigitalOcean.SshKey");

class SshKeyNotRenamed extends Data.TaggedError("SshKeyNotRenamed")<{
  readonly sshKeyId: number;
  readonly name: string;
}> {
  override get message() {
    return `SSH key ${this.sshKeyId} did not show the name '${this.name}' in time.`;
  }
}

class SshKeyStillPresent extends Data.TaggedError("SshKeyStillPresent")<{
  readonly sshKeyId: number;
}> {
  override get message() {
    return `SSH key ${this.sshKeyId} still exists after delete.`;
  }
}

// DigitalOcean stores the key text verbatim, comment included. Only the
// surrounding whitespace is noise.
const normalizeKey = (publicKey: string) => publicKey.trim();

// A key has no field for an ownership mark. The name is the only tie
// between a registration and this resource.
const isOurs = (key: ApiSshKey, publicKey: string, name: string) =>
  normalizeKey(key.public_key) === publicKey && key.name === name;

export const SshKeyProvider = () =>
  Provider.effect(
    SshKey,
    Effect.gen(function* () {
      const create = yield* sshKeysCreate;
      const get = yield* sshKeysGet;
      const update = yield* sshKeysUpdate;
      const del = yield* sshKeysDelete;
      const list = yield* sshKeysList;

      const toAttrs = (key: ApiSshKey) => ({
        sshKeyId: key.id,
        name: key.name,
        fingerprint: key.fingerprint,
        publicKey: key.public_key,
      });

      const observeById = (sshKeyId: number) =>
        get({ ssh_key_identifier: String(sshKeyId) }).pipe(
          Effect.map((r) => Option.some(r.ssh_key)),
          Effect.catchTag("NotFound", () =>
            Effect.succeed(Option.none<ApiSshKey>()),
          ),
        );

      const listAll = listAllPages(list, (r) => r.ssh_keys ?? []);

      const observeByContent = (publicKey: string) =>
        listAll.pipe(
          Effect.map((keys) =>
            Arr.findFirst(
              keys,
              (k) => normalizeKey(k.public_key) === publicKey,
            ),
          ),
        );

      const foreignKey = (id: string, key: ApiSshKey) =>
        new OwnedBySomeoneElse({
          message:
            `SSH key '${key.name}' (${key.id}) already registers this key ` +
            "material and cannot be proven ours. Re-run with `--adopt` " +
            "(or `adopt(true)`) to take it over.",
          resourceType: SshKey.Type,
          logicalId: id,
          physicalName: key.name,
        });

      /** Finds the registration of `publicKey`. Fails when it is not ours. */
      const observeOurs = Effect.fn(function* (
        id: string,
        publicKey: string,
        name: string,
      ) {
        const existing = yield* observeByContent(publicKey);
        if (
          Option.isSome(existing) &&
          !isOurs(existing.value, publicKey, name)
        ) {
          return yield* foreignKey(id, existing.value);
        }
        return existing;
      });

      const physicalName = (id: string) =>
        createPhysicalName({ id, maxLength: 255 });

      return {
        stables: ["sshKeyId", "fingerprint", "publicKey"],
        list: Effect.fn(function* () {
          return (yield* listAll).map(toAttrs);
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          if (output !== undefined) {
            const existing = yield* observeById(output.sshKeyId);
            return Option.getOrUndefined(Option.map(existing, toAttrs));
          }
          if (olds?.publicKey === undefined) return undefined;
          const publicKey = normalizeKey(olds.publicKey);
          const name = olds.name ?? (yield* physicalName(id));
          const existing = yield* observeByContent(publicKey);
          if (Option.isNone(existing)) return undefined;
          if (isOurs(existing.value, publicKey, name)) {
            return toAttrs(existing.value);
          }
          return Unowned(toAttrs(existing.value));
        }),
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news) || olds === undefined) return undefined;
          if (normalizeKey(news.publicKey) !== normalizeKey(olds.publicKey)) {
            return { action: "replace" } as const;
          }
          if (news.name !== olds.name) {
            return { action: "update" } as const;
          }
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, output }) {
          const desiredName = news.name ?? (yield* physicalName(id));
          const publicKey = normalizeKey(news.publicKey);

          const cached =
            output === undefined
              ? Option.none<ApiSshKey>()
              : yield* observeById(output.sshKeyId);
          // DigitalOcean cannot change the key material of an existing key.
          if (
            Option.isSome(cached) &&
            normalizeKey(cached.value.public_key) !== publicKey
          ) {
            return yield* new ReplacementRequired({
              resourceType: SshKey.Type,
              physicalId: String(cached.value.id),
              properties: ["publicKey"],
            });
          }

          const observed = Option.isSome(cached)
            ? cached
            : yield* observeOurs(id, publicKey, desiredName);

          if (Option.isNone(observed)) {
            const created = yield* create({
              name: desiredName,
              public_key: publicKey,
            }).pipe(
              Effect.map((r) => r.ssh_key),
              // DigitalOcean answers 422 when the key material is already
              // registered.
              Effect.catchTag("UnprocessableEntity", (error) =>
                observeOurs(id, publicKey, desiredName).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(error),
                      onSome: Effect.succeed,
                    }),
                  ),
                ),
              ),
            );
            return toAttrs(created);
          }

          const key = observed.value;
          if (key.name === desiredName) return toAttrs(key);
          yield* update({
            ssh_key_identifier: String(key.id),
            name: desiredName,
          });
          // GET can still return the old name for a moment after PUT.
          const renamed = yield* pollUntil(
            observeById(key.id),
            (observed) => observed.name === desiredName,
            {
              every: "1 second",
              times: 10,
              timeout: "30 seconds",
              notSettled: () =>
                new SshKeyNotRenamed({ sshKeyId: key.id, name: desiredName }),
            },
          );
          return toAttrs(renamed);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* del({ ssh_key_identifier: String(output.sshKeyId) }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
          );
          // GET can still return the key for a moment after DELETE.
          yield* pollUntilGone(observeById(output.sshKeyId), {
            every: "1 second",
            times: 10,
            timeout: "30 seconds",
            stillPresent: () =>
              new SshKeyStillPresent({ sshKeyId: output.sshKeyId }),
          });
        }),
      };
    }),
  );
