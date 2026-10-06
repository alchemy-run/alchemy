import { createHash } from "node:crypto";
import * as DO from "@distilled.cloud/digitalocean";
import type { SshKeys as ApiSshKey } from "@distilled.cloud/digitalocean";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { OwnedBySomeoneElse, Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import type { Input } from "../Input.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { pollUntil, type PollBudget } from "../Util/poll.ts";
import { ignoreNotFound, noneIfNotFound } from "./notFound.ts";
import type { Providers } from "./Providers.ts";

export type SshKeyProps = {
  /**
   * Display name for the key. A change renames the key in place.
   *
   * @default a generated physical name
   */
  name?: string;

  /**
   * The public key in `authorized_keys` format (`ssh-ed25519 AAAA… note`).
   * A change to the key material replaces the resource. A change to the
   * trailing comment does not.
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
    /** The registered public key, as given. */
    publicKey: string;
  },
  never,
  Providers
>;

export type SshKeyAttributes = SshKey["Attributes"];

/**
 * An SSH public key registered on the DigitalOcean team. Droplets created
 * with it accept the key for `root`. The fingerprint of the key material
 * identifies the key, and DigitalOcean rejects a second registration of
 * the same material. A change to the material replaces the resource. A
 * change to `name` updates in place.
 *
 * A key has no ownership tag. A generated name proves that alchemy
 * registered the key. The same material registered under a name you chose
 * is `Unowned` and needs `--adopt`.
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

export class SshKeyUnparseable extends Data.TaggedError("DigitalOcean.SshKeyUnparseable")<{
  readonly publicKey: string;
}> {
  override get message() {
    return "The public key is not in authorized_keys format (`<type> <base64 material> [comment]`).";
  }
}

export class SshKeyWaitTimedOut extends Data.TaggedError("DigitalOcean.SshKeyWaitTimedOut")<{
  readonly sshKeyId: number;
  readonly waitingFor: string;
}> {
  override get message() {
    return `SSH key ${this.sshKeyId} did not show ${this.waitingFor} in time.`;
  }
}

export class SshKeyStillExists extends Data.TaggedError("DigitalOcean.SshKeyStillExists")<{
  readonly sshKeyId: number;
}> {
  override get message() {
    return `SSH key ${this.sshKeyId} still exists after delete.`;
  }
}

const NAME_MAX_LENGTH = 255;

const PAGE_SIZE = 200;

// GET can lag a change by a few seconds.
const SSH_KEY_POLL: PollBudget = { every: "1 second", times: 10 };

/** The base64 field of an `authorized_keys` line, without type and comment. */
const keyMaterial = (publicKey: string) => publicKey.trim().split(/\s+/)[1];

/** DigitalOcean's fingerprint: the MD5 of the key material in colon-separated hex. */
const fingerprintOf = (publicKey: string) =>
  Effect.sync(() => {
    const material = keyMaterial(publicKey);
    if (material === undefined) return Option.none<string>();
    const digest = createHash("md5").update(Buffer.from(material, "base64")).digest();
    return Option.some(Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(":"));
  }).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new SshKeyUnparseable({ publicKey })),
        onSome: Effect.succeed,
      }),
    ),
  );

const hasName = (name: string) => (key: ApiSshKey) => key.name === name;

const hasFingerprint = (fingerprint: string) => (key: ApiSshKey) => key.fingerprint === fingerprint;

/**
 * Replaces on new key material. A rename is left to the engine's in-place
 * update.
 *
 * @internal exported for unit testing
 */
export const diffSshKey = (news: Input<SshKeyProps>, olds: SshKeyProps) => {
  if (!isResolved(news)) return undefined;
  const needsReplacement = keyMaterial(news.publicKey) !== keyMaterial(olds.publicKey);
  return needsReplacement ? ({ action: "replace" } as const) : undefined;
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

// The API accepts an id or a fingerprint as the key identifier.
const observe = (identifier: string) =>
  noneIfNotFound(
    DO.getSshKey({ ssh_key_identifier: identifier }).pipe(
      Effect.map((response) => response.ssh_key),
    ),
  );

const observeById = (sshKeyId: number) => observe(String(sshKeyId));

const listAll = DO.listSshKeys.items({ per_page: PAGE_SIZE }).pipe(Stream.runCollect);

// The stored id is a cache. The fingerprint finds the key without it.
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

const waitUntilGone = (sshKeyId: number) =>
  pollUntil(observeById(sshKeyId), {
    ...SSH_KEY_POLL,
    until: Option.isNone,
    onTimeout: () => new SshKeyStillExists({ sshKeyId }),
  });

// A concurrent deploy of this resource can register the key first. A
// registration under another name belongs to someone else.
const observeOwnRegistration = Effect.fn(function* (id: string, fingerprint: string, name: string) {
  const registeredKey = yield* observe(fingerprint);
  if (Option.isSome(registeredKey) && !hasName(name)(registeredKey.value)) {
    return yield* registeredBySomeoneElse(id, registeredKey.value);
  }
  return registeredKey;
});

const register = (id: string, publicKey: string, fingerprint: string, name: string) =>
  DO.createSshKey({ name, public_key: publicKey }).pipe(
    Effect.map((response) => response.ssh_key),
    Effect.catchTag("SshKeyAlreadyRegistered", (rejection) =>
      observeOwnRegistration(id, fingerprint, name).pipe(
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
        until: hasFingerprint(fingerprint),
        waitingFor: "the registered key",
      }),
    ),
  );

const syncName = Effect.fn(function* (key: ApiSshKey, name: string) {
  if (hasName(name)(key)) return key;
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
      if (output !== undefined) {
        const byId = yield* observeById(output.sshKeyId);
        if (Option.isSome(byId)) return toAttrs(byId.value);
      }
      const registeredKey = yield* observe(yield* fingerprintOf(olds.publicKey));
      if (Option.isNone(registeredKey)) return undefined;
      // A generated name proves ownership. A chosen name proves nothing,
      // so the key belongs to someone else until `--adopt` says otherwise.
      const generatedName = olds.name === undefined ? yield* physicalName(id) : undefined;
      const attrs = toAttrs(registeredKey.value);
      return generatedName !== undefined && hasName(generatedName)(registeredKey.value)
        ? attrs
        : Unowned(attrs);
    }),
    diff: ({ olds, news }) => Effect.succeed(diffSshKey(news, olds)),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name = news.name ?? (yield* physicalName(id));
      const publicKey = news.publicKey.trim();
      const fingerprint = yield* fingerprintOf(publicKey);

      const observed = yield* observeByIdOrFingerprint(output?.sshKeyId, fingerprint);
      const key = yield* Option.match(observed, {
        onNone: () => register(id, publicKey, fingerprint, name),
        onSome: Effect.succeed,
      });
      return toAttrs(yield* syncName(key, name));
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(DO.deleteSshKey({ ssh_key_identifier: String(output.sshKeyId) }));
      yield* waitUntilGone(output.sshKeyId);
    }),
  });
