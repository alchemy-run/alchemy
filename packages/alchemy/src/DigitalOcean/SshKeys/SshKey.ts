import * as DO from "@distilled.cloud/digitalocean";
import type { SshKeys as ApiSshKey } from "@distilled.cloud/digitalocean";
import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { OwnedBySomeoneElse, Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { ignoreNotFound, noneIfNotFound } from "../notFound.ts";
import { collectPages } from "../pagination.ts";
import { pollUntil, type PollBudget } from "../poll.ts";
import type { Providers } from "../Providers.ts";

export type SshKeyProps = {
  /**
   * Display name for the key. A change renames the key in place.
   *
   * @default a generated physical name
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

export type SshKeyAttributes = SshKey["Attributes"];

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
 * ### Creating an SSH Key
 * **Example:** Register a Deploy Key and Create a Droplet with It
 * ```typescript
 * const key = yield* DigitalOcean.SshKey("deploy-key", {
 *   publicKey: yield* Config.string("SSH_PUBLIC_KEY"),
 * });
 * const host = yield* DigitalOcean.Droplet("app", {
 *   region: "sfo3",
 *   size: "s-2vcpu-4gb",
 *   image: "ubuntu-24-04-x64",
 *   sshKeys: [key.fingerprint],
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/SSH-Keys
 *
 * @resource
 * @product SSH Keys
 * @category Compute
 */
export const SshKey = Resource<SshKey>("DigitalOcean.SshKey");

export class SshKeyWaitTimedOut extends Data.TaggedError("SshKeyWaitTimedOut")<{
  readonly sshKeyId: number;
  readonly waitingFor: string;
}> {
  override get message() {
    return `SSH key ${this.sshKeyId} did not show ${this.waitingFor} in time.`;
  }
}

export class SshKeyStillExists extends Data.TaggedError("SshKeyStillExists")<{
  readonly sshKeyId: number;
}> {
  override get message() {
    return `SSH key ${this.sshKeyId} still exists after delete.`;
  }
}

const NAME_MAX_LENGTH = 255;

const REPLACE = { action: "replace" } as const;

// GET can lag a change by a few seconds.
const SSH_KEY_POLL: PollBudget = { every: "1 second", times: 10 };

// DigitalOcean stores the key text as given, comment included. Only
// surrounding whitespace is ignored.
const normalize = (publicKey: string) => publicKey.trim();

const registers = (publicKey: string) => (key: ApiSshKey) =>
  normalize(key.public_key) === publicKey;

const hasName = (name: string) => (key: ApiSshKey) => key.name === name;

/**
 * Replaces on new key material. A rename is left to the engine's in-place
 * update.
 *
 * @internal exported for unit testing
 */
export const diffSshKey = (news: Input<SshKeyProps>, olds: SshKeyProps) => {
  if (!isResolved(news)) return undefined;
  const replaces = normalize(news.publicKey) !== normalize(olds.publicKey);
  return replaces ? REPLACE : undefined;
};

const toAttrs = (key: ApiSshKey): SshKeyAttributes => ({
  sshKeyId: key.id,
  name: key.name,
  fingerprint: key.fingerprint,
  publicKey: key.public_key,
});

const physicalName = (id: string) => createPhysicalName({ id, maxLength: NAME_MAX_LENGTH });

const registeredBySomeoneElse = (id: string, key: ApiSshKey) =>
  new OwnedBySomeoneElse({
    message:
      `SSH key '${key.name}' (${key.id}) already registers this ` +
      "public key. Alchemy did not create it. Re-run with `--adopt` " +
      "(or `adopt(true)`) to take it over.",
    resourceType: SshKey.Type,
    logicalId: id,
    physicalName: key.name,
  });

export const SshKeyProvider = () =>
  Provider.effect(
    SshKey,
    Effect.gen(function* () {
      const create = yield* DO.createSshKey;
      const get = yield* DO.getSshKey;
      const update = yield* DO.updateSshKey;
      const deleteSshKey = yield* DO.deleteSshKey;
      const list = yield* DO.listSshKeys;

      const observeById = (sshKeyId: number) =>
        noneIfNotFound(
          get({ ssh_key_identifier: String(sshKeyId) }).pipe(
            Effect.map((response) => response.ssh_key),
          ),
        );

      const listAll = collectPages(list, (response) => response.ssh_keys ?? []);

      const observeRegistration = (publicKey: string) =>
        listAll.pipe(Effect.map(Arr.findFirst(registers(publicKey))));

      // A key has no field for an ownership tag. The name is the only tie
      // between a registration and this resource.
      const observeOwnRegistration = Effect.fn(function* (
        id: string,
        publicKey: string,
        name: string,
      ) {
        const registration = yield* observeRegistration(publicKey);
        if (Option.isSome(registration) && !hasName(name)(registration.value)) {
          return yield* registeredBySomeoneElse(id, registration.value);
        }
        return registration;
      });

      // The stored id is a cache. The public key finds the key without it.
      const observeOwned = Effect.fn(function* (
        id: string,
        sshKeyId: number | undefined,
        publicKey: string,
        name: string,
      ) {
        if (sshKeyId !== undefined) {
          const byId = yield* observeById(sshKeyId);
          if (Option.isSome(byId)) return byId;
        }
        return yield* observeOwnRegistration(id, publicKey, name);
      });

      const waitForKey = (
        sshKeyId: number,
        wait: {
          readonly until: (key: ApiSshKey) => boolean;
          readonly waitingFor: string;
        },
      ) =>
        pollUntil(observeById(sshKeyId), {
          ...SSH_KEY_POLL,
          until: (observed): observed is Option.Some<ApiSshKey> =>
            Option.isSome(observed) && wait.until(observed.value),
          onTimeout: () => new SshKeyWaitTimedOut({ sshKeyId, waitingFor: wait.waitingFor }),
        }).pipe(Effect.map((observed) => observed.value));

      const waitUntilGone = (sshKeyId: number) =>
        pollUntil(observeById(sshKeyId), {
          ...SSH_KEY_POLL,
          until: Option.isNone,
          onTimeout: () => new SshKeyStillExists({ sshKeyId }),
        });

      // DigitalOcean answers 422 when the public key is already registered,
      // which a concurrent deploy of this resource can cause.
      const register = (id: string, publicKey: string, name: string) =>
        create({ name, public_key: publicKey }).pipe(
          Effect.map((response) => response.ssh_key),
          Effect.catchTag("UnprocessableEntity", (rejection) =>
            observeOwnRegistration(id, publicKey, name).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.fail(rejection),
                  onSome: Effect.succeed,
                }),
              ),
            ),
          ),
          // A droplet created right after cannot use a key that GET does
          // not return yet.
          Effect.flatMap((key) =>
            waitForKey(key.id, {
              until: registers(publicKey),
              waitingFor: "the registered key",
            }),
          ),
        );

      const syncName = Effect.fn(function* (key: ApiSshKey, name: string) {
        if (hasName(name)(key)) return key;
        yield* update({ ssh_key_identifier: String(key.id), name });
        return yield* waitForKey(key.id, {
          until: hasName(name),
          waitingFor: `the name '${name}'`,
        });
      });

      return {
        stables: ["sshKeyId", "fingerprint", "publicKey"],
        // A key carries no ownership marker, so a list cannot tell the keys
        // Alchemy registered from the rest of the team's.
        nuke: { skip: true },
        list: Effect.fn(function* () {
          return (yield* listAll).map(toAttrs);
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          if (output !== undefined) {
            const observed = yield* observeById(output.sshKeyId);
            return Option.getOrUndefined(Option.map(observed, toAttrs));
          }
          const registration = yield* observeRegistration(normalize(olds.publicKey));
          if (Option.isNone(registration)) return undefined;
          const name = olds.name ?? (yield* physicalName(id));
          const attrs = toAttrs(registration.value);
          return hasName(name)(registration.value) ? attrs : Unowned(attrs);
        }),
        diff: ({ olds, news }) => Effect.succeed(diffSshKey(news, olds)),
        reconcile: Effect.fn(function* ({ id, news, output }) {
          const name = news.name ?? (yield* physicalName(id));
          const publicKey = normalize(news.publicKey);

          const observed = yield* observeOwned(id, output?.sshKeyId, publicKey, name);
          const key = yield* Option.match(observed, {
            onNone: () => register(id, publicKey, name),
            onSome: Effect.succeed,
          });
          return toAttrs(yield* syncName(key, name));
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* ignoreNotFound(deleteSshKey({ ssh_key_identifier: String(output.sshKeyId) }));
          yield* waitUntilGone(output.sshKeyId);
        }),
      };
    }),
  );
