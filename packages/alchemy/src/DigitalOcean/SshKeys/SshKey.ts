import * as DO from "@distilled.cloud/digitalocean";
import type { SshKeys as ApiSshKey } from "@distilled.cloud/digitalocean";
import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { OwnedBySomeoneElse, Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { pollUntil, pollUntilGone, type PollOptions } from "../../Util/poll.ts";
import { listAllPages } from "../paginate.ts";
import type { Providers } from "../Providers.ts";

export type SshKeyProps = {
  /**
   * Display name for the key. Defaults to a generated physical name. A
   * change renames the key in place.
   */
  name?: string;
  /**
   * The public key in `authorized_keys` format (`ssh-ed25519 AAAA… note`).
   * A change replaces the resource.
   */
  publicKey: string;
};

export type SshKey = Resource<
  "DigitalOcean.SshKey",
  SshKeyProps,
  {
    /** Numeric key id. */
    sshKeyId: number;
    /** Display name. */
    name: string;
    /** MD5 fingerprint that DigitalOcean derives from the public key. */
    fingerprint: string;
    /** The registered public key, as given. */
    publicKey: string;
  },
  never,
  Providers
>;

/**
 * An SSH public key registered on the DigitalOcean team. Droplets created
 * with it accept the key for `root`. DigitalOcean derives `fingerprint`
 * from `publicKey` and rejects duplicates. A change to `publicKey`
 * replaces the resource. A change to `name` updates in place.
 *
 * A key has no ownership tag. If the same public key is registered under
 * another name, it belongs to someone else. It is `Unowned` and needs
 * `--adopt`.
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/SSH-Keys
 *
 * ### Creating an SshKey
 * **Example:** Register a deploy key and create a droplet with it
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
 *
 * @resource
 * @product SSH Keys
 * @category Compute
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

const SSH_KEY_POLL: PollOptions = { every: "1 second", times: 10 };

// DigitalOcean stores the key text as given, comment included. Only
// surrounding whitespace is ignored.
const normalizeKey = (publicKey: string) => publicKey.trim();

// A key has no field for an ownership tag. The name is the only tie
// between a registration and this resource.
const isOurs = (key: ApiSshKey, publicKey: string, name: string) =>
  normalizeKey(key.public_key) === publicKey && key.name === name;

export const SshKeyProvider = () =>
  Provider.effect(
    SshKey,
    Effect.gen(function* () {
      const create = yield* DO.createSshKey;
      const get = yield* DO.getSshKey;
      const update = yield* DO.updateSshKey;
      const deleteSshKey = yield* DO.deleteSshKey;
      const list = yield* DO.listSshKeys;

      const toAttrs = (key: ApiSshKey) => ({
        sshKeyId: key.id,
        name: key.name,
        fingerprint: key.fingerprint,
        publicKey: key.public_key,
      });

      const observeById = (sshKeyId: number) =>
        get({ ssh_key_identifier: String(sshKeyId) }).pipe(
          Effect.map((response) => Option.some(response.ssh_key)),
          Effect.catchTag("NotFound", () =>
            Effect.succeed(Option.none<ApiSshKey>()),
          ),
        );

      const listAll = listAllPages(list, (response) => response.ssh_keys ?? []);

      const observeByPublicKey = (publicKey: string) =>
        listAll.pipe(
          Effect.map((keys) =>
            Arr.findFirst(
              keys,
              (key) => normalizeKey(key.public_key) === publicKey,
            ),
          ),
        );

      const foreignRegistrationError = (id: string, key: ApiSshKey) =>
        new OwnedBySomeoneElse({
          message:
            `SSH key '${key.name}' (${key.id}) already registers this ` +
            "public key. Alchemy did not create it. Re-run with `--adopt` " +
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
        const existing = yield* observeByPublicKey(publicKey);
        if (
          Option.isSome(existing) &&
          !isOurs(existing.value, publicKey, name)
        ) {
          return yield* foreignRegistrationError(id, existing.value);
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
          const existing = yield* observeByPublicKey(publicKey);
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

          const observeCurrent = Effect.gen(function* () {
            if (output !== undefined) {
              const existingById = yield* observeById(output.sshKeyId);
              if (Option.isSome(existingById)) return existingById;
            }
            return yield* observeOurs(id, publicKey, desiredName);
          });
          const observed = yield* observeCurrent;

          if (Option.isNone(observed)) {
            const created = yield* create({
              name: desiredName,
              public_key: publicKey,
            }).pipe(
              Effect.map((response) => response.ssh_key),
              // DigitalOcean answers 422 when the public key is already
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
              ...SSH_KEY_POLL,
              notSettled: () =>
                new SshKeyNotRenamed({ sshKeyId: key.id, name: desiredName }),
            },
          );
          return toAttrs(renamed);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* deleteSshKey({
            ssh_key_identifier: String(output.sshKeyId),
          }).pipe(Effect.catchTag("NotFound", () => Effect.void));
          // GET can still return the key for a moment after DELETE.
          yield* pollUntilGone(observeById(output.sshKeyId), {
            ...SSH_KEY_POLL,
            stillPresent: () =>
              new SshKeyStillPresent({ sshKeyId: output.sshKeyId }),
          });
        }),
      };
    }),
  );
