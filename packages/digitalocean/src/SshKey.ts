import * as DO from "@distilled.cloud/digitalocean";
import type { SshKeys as ApiSshKey, SshKeyAlreadyRegistered } from "@distilled.cloud/digitalocean";
import { OwnedBySomeoneElse, Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { type AuthorizedKey, parseAuthorizedKey } from "./internal/authorizedKey.ts";
import { ignoreNotFound, noneIfNotFound } from "./internal/notFound.ts";
import { pollUntil, type PollBudget } from "./internal/poll.ts";
import type { Providers } from "./Providers.ts";

export type SshKeyProps = {
  /**
   * Display name for the key. A change renames the key in place.
   *
   * @default a generated physical name
   */
  name?: string;

  /**
   * The public key, either an `authorized_keys` line (`ssh-ed25519 AAAA… note`)
   * or a PEM public key such as `KeyPair` produces. A change to the key
   * material replaces the resource. A change to the trailing comment does not.
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
    /** MD5 fingerprint of the key material, as DigitalOcean reports it. */
    fingerprint: string;
    /** The registered public key as an `authorized_keys` line. */
    publicKey: string;
  },
  never,
  Providers
>;

export type SshKeyAttributes = SshKey["Attributes"];

/**
 * An SSH public key registered on the DigitalOcean team. Droplets created
 * with it accept the key for `root`. The fingerprint of the key material
 * identifies the key, and DigitalOcean allows one registration per key
 * material. A change to the material replaces the resource. A change to
 * `name` updates in place.
 *
 * A key has no ownership tag, so only the name alchemy generates for it
 * proves that alchemy registered it. The same material registered under
 * any other name is `Unowned` and needs `--adopt`, so omitting `name` does
 * not help.
 *
 * When new material is still an unresolved `Output` at plan time, as the
 * public key of a replaced `KeyPair` is, the first deploy fails with
 * `SshKeyMaterialChanged` and the next one replaces the key.
 *
 * ### Creating an SSH Key
 * **Example:** Register a deploy key and create a droplet with it
 * ```typescript
 * const key = yield* DigitalOcean.SshKey("deploy-key", {
 *   publicKey: yield* Config.String("SSH_PUBLIC_KEY"),
 * });
 * const host = yield* DigitalOcean.Droplet("app", {
 *   region: "sfo3",
 *   size: "s-2vcpu-4gb",
 *   image: "ubuntu-24-04-x64",
 *   sshKeys: [key.fingerprint],
 * });
 * ```
 *
 * **Example:** Generate the key pair in the stack
 * ```typescript
 * const pair = yield* Alchemy.KeyPair("deploy-key-pair");
 * const key = yield* DigitalOcean.SshKey("deploy-key", {
 *   publicKey: pair.publicKey,
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

export class SshKeyUnparseable extends Data.TaggedError("DigitalOcean.SshKeyUnparseable") {
  override get message() {
    return "The public key is neither an authorized_keys line (`<type> <base64 material> [comment]`) nor a PEM public key.";
  }
}

export class SshKeyMaterialChanged extends Data.TaggedError("DigitalOcean.SshKeyMaterialChanged")<{
  readonly sshKeyId: number;
}> {
  override get message() {
    return (
      `SSH key ${this.sshKeyId} holds other key material than \`publicKey\`, ` +
      "which was unresolved when the deploy was planned. DigitalOcean cannot " +
      "change the material of a key. Deploy again to replace the key."
    );
  }
}

export class SshKeyWaitTimedOut extends Data.TaggedError("DigitalOcean.SshKeyWaitTimedOut")<{
  readonly sshKeyId: number;
  readonly waitingFor: string;
}> {
  override get message() {
    return `SSH key ${this.sshKeyId} timed out waiting for ${this.waitingFor}.`;
  }
}

const NAME_MAX_LENGTH = 255;

const PAGE_SIZE = 200;

// GET lags a change by a few seconds.
const SSH_KEY_POLL: PollBudget = { maxDelay: "3 seconds", times: 15 };

const parsePublicKey = (publicKey: string) =>
  Effect.sync(() => parseAuthorizedKey(publicKey)).pipe(
    Effect.flatMap(Effect.fromOption(() => new SshKeyUnparseable())),
  );

const hasName = (name: string) => (key: ApiSshKey) => key.name === name;

const hasFingerprint = (fingerprint: string) => (key: ApiSshKey) => key.fingerprint === fingerprint;

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

// A key has no ownership tag. The recorded id or the generated name proves
// that alchemy registered it.
const isRegisteredByAlchemy = Effect.fn(function* (
  key: ApiSshKey,
  resource: {
    readonly id: string;
    readonly olds: SshKeyProps;
    readonly output: SshKeyAttributes | undefined;
  },
) {
  if (key.id === resource.output?.sshKeyId) return true;
  return resource.olds.name === undefined && key.name === (yield* physicalName(resource.id));
});

// The API accepts an id or a fingerprint as the key identifier.
const observe = (identifier: string) =>
  noneIfNotFound(
    DO.getSshKey({ ssh_key_identifier: identifier }).pipe(
      Effect.map((response) => response.ssh_key),
    ),
  );

const observeById = (sshKeyId: number) => observe(String(sshKeyId));

const listAll = DO.listSshKeys.items({ per_page: PAGE_SIZE }).pipe(Stream.runCollect);

const observeByIdOrFingerprint = Effect.fn(function* (
  sshKeyId: number | undefined,
  fingerprint: string,
) {
  if (sshKeyId !== undefined) {
    const byId = yield* observeById(sshKeyId);
    if (Option.isSome(byId)) return byId;
  }
  return yield* observe(fingerprint);
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

// A key registered moments ago answers DELETE with 404 while GET still
// returns it, so the delete is repeated until the key is gone.
const deleteOnce = (sshKeyId: number) =>
  ignoreNotFound(DO.deleteSshKey({ ssh_key_identifier: String(sshKeyId) })).pipe(
    Effect.andThen(observeById(sshKeyId)),
  );

const deleteUntilGone = (sshKeyId: number) =>
  pollUntil(deleteOnce(sshKeyId), {
    ...SSH_KEY_POLL,
    until: Option.isNone,
    onTimeout: () => new SshKeyWaitTimedOut({ sshKeyId, waitingFor: "deletion" }),
  });

// A concurrent deploy of this resource can register the key first. A
// registration under another name belongs to someone else.
const recoverRegistration = Effect.fn(function* (
  id: string,
  key: AuthorizedKey,
  name: string,
  rejection: SshKeyAlreadyRegistered,
) {
  const registered = yield* observe(key.fingerprint).pipe(
    Effect.flatMap(Effect.fromOption(() => rejection)),
  );
  if (registered.name !== name) return yield* registeredBySomeoneElse(id, registered);
  return registered;
});

const register = (id: string, key: AuthorizedKey, name: string) =>
  DO.createSshKey({ name, public_key: key.line }).pipe(
    Effect.map((response) => response.ssh_key),
    Effect.catchTag("SshKeyAlreadyRegistered", (rejection) =>
      recoverRegistration(id, key, name, rejection),
    ),
    // A droplet created right after cannot use a key that GET does
    // not return yet.
    Effect.flatMap((registered) =>
      waitForKey(registered.id, {
        until: hasFingerprint(key.fingerprint),
        waitingFor: "the registered key",
      }),
    ),
  );

const syncName = Effect.fn(function* (key: ApiSshKey, name: string) {
  if (key.name === name) return key;
  yield* DO.updateSshKey({ ssh_key_identifier: String(key.id), name });
  return yield* waitForKey(key.id, {
    until: hasName(name),
    waitingFor: `the name '${name}'`,
  });
});

export const SshKeyProvider = () =>
  Provider.succeed(SshKey, {
    stables: ["sshKeyId", "fingerprint", "publicKey"],
    // A key carries no ownership marker, so a list cannot tell the keys
    // Alchemy registered from the rest of the team's.
    nuke: { skip: true },
    list: Effect.fn(function* () {
      return (yield* listAll).map(toAttrs);
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      const { fingerprint } = yield* parsePublicKey(olds.publicKey);
      const observed = yield* observeByIdOrFingerprint(output?.sshKeyId, fingerprint);
      if (Option.isNone(observed)) return undefined;
      const attrs = toAttrs(observed.value);
      return (yield* isRegisteredByAlchemy(observed.value, { id, olds, output }))
        ? attrs
        : Unowned(attrs);
    }),
    // Compares with the registered key, not `olds`: after a failed rotation
    // `olds` already holds the new material.
    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined || !("publicKey" in news) || !isResolved(news.publicKey)) {
        return undefined;
      }
      const desired = yield* parsePublicKey(news.publicKey);
      if (desired.fingerprint !== output.fingerprint) return { action: "replace" } as const;
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name = news.name ?? (yield* physicalName(id));
      const desired = yield* parsePublicKey(news.publicKey);

      const observed = yield* observeByIdOrFingerprint(output?.sshKeyId, desired.fingerprint);
      const key = yield* Option.match(observed, {
        onNone: () => register(id, desired, name),
        onSome: Effect.succeed,
      });
      // Only a plan that could not resolve `publicKey` updates a key to new material.
      if (key.fingerprint !== desired.fingerprint) {
        return yield* new SshKeyMaterialChanged({ sshKeyId: key.id });
      }
      return toAttrs(yield* syncName(key, name));
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* deleteUntilGone(output.sshKeyId);
    }),
  });
