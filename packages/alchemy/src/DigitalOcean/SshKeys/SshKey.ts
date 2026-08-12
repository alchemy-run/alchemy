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
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { listAllPages } from "../paginate.ts";
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

// DigitalOcean stores the uploaded string verbatim, comment field included.
const normalizeKey = (publicKey: string) => publicKey.trim();

class SshKeyExistsUnowned extends Data.TaggedError("SshKeyExistsUnowned")<{
  readonly name: string;
  readonly sshKeyId: number;
}> {
  override get message() {
    return `An SSH key with this key material already exists as "${this.name}" (${this.sshKeyId}). Re-deploy with --adopt to take it over.`;
  }
}

class SshKeyReplacementRequired extends Data.TaggedError(
  "SshKeyReplacementRequired",
)<{
  readonly sshKeyId: number;
}> {
  override get message() {
    return `SSH key ${this.sshKeyId}'s material changed but no replacement was planned (an unresolved prop hid the change from diff). Re-run the deploy.`;
  }
}

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

      const observeById = (identifier: string) =>
        get({ ssh_key_identifier: identifier }).pipe(
          Effect.map((r) => Option.some(r.ssh_key)),
          Effect.catchTag("NotFound", () =>
            Effect.succeed(Option.none<ApiSshKey>()),
          ),
        );

      const listAll = listAllPages((q) =>
        list(q).pipe(Effect.map((r) => r.ssh_keys ?? [])),
      );

      /** The key material is the identity — exact content match. */
      const observeByContent = (publicKey: string) =>
        listAll.pipe(
          Effect.map((keys) =>
            Arr.findFirst(
              keys,
              (k) => normalizeKey(k.public_key) === publicKey,
            ),
          ),
        );

      return {
        stables: ["sshKeyId", "fingerprint", "publicKey"],
        list: Effect.fn(function* () {
          return (yield* listAll).map(toAttrs);
        }),
        read: Effect.fn(function* ({ olds, output }) {
          if (output !== undefined) {
            const existing = yield* observeById(String(output.sshKeyId));
            return Option.getOrUndefined(Option.map(existing, toAttrs));
          }
          // Identical key material proves possession of the key, not that
          // we registered it — surface as Unowned so a takeover (and the
          // eventual stack-destroy delete) needs an explicit `--adopt`.
          if (olds?.publicKey === undefined) return undefined;
          const existing = yield* observeByContent(
            normalizeKey(olds.publicKey),
          );
          return Option.getOrUndefined(
            Option.map(existing, (key) => Unowned(toAttrs(key))),
          );
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
          const desiredName =
            news.name ?? (yield* createPhysicalName({ id, maxLength: 255 }));
          const publicKey = normalizeKey(news.publicKey);

          // Observe — cached id first; else a content scan, so a crash
          // after create converges on the existing key instead of failing
          // on the duplicate-key 422.
          const cached =
            output !== undefined
              ? yield* observeById(String(output.sshKeyId))
              : Option.none<ApiSshKey>();
          const observed = Option.isSome(cached)
            ? cached
            : yield* observeByContent(publicKey);

          // The key material is create-time-only: if the cached key's
          // content no longer matches desired, the change reached reconcile
          // without a replace plan and cannot be applied here. Failing is
          // self-healing — the next, fully resolved plan replaces.
          if (
            Option.isSome(cached) &&
            normalizeKey(cached.value.public_key) !== publicKey
          ) {
            return yield* new SshKeyReplacementRequired({
              sshKeyId: cached.value.id,
            });
          }

          // A content match that we cannot tie to this resource (no cached
          // id, name differs from ours) is someone else's registration of
          // the same key — renaming it here would hijack it; `--adopt` is
          // the only takeover path.
          if (
            output === undefined &&
            Option.isSome(observed) &&
            observed.value.name !== desiredName
          ) {
            return yield* new SshKeyExistsUnowned({
              name: observed.value.name,
              sshKeyId: observed.value.id,
            });
          }

          // Ensure — a 422 is the duplicate-key race with a concurrent
          // registration: re-observe and converge on the winner.
          if (Option.isNone(observed)) {
            const created = yield* create({
              name: desiredName,
              public_key: publicKey,
            }).pipe(
              Effect.map((r) => r.ssh_key),
              Effect.catchTag("UnprocessableEntity", (error) =>
                observeByContent(publicKey).pipe(
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

          // Sync — the only mutable aspect is the name.
          const key = observed.value;
          if (key.name !== desiredName) {
            const updated = yield* update({
              ssh_key_identifier: String(key.id),
              name: desiredName,
            });
            return toAttrs(updated.ssh_key);
          }
          return toAttrs(key);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* del({ ssh_key_identifier: String(output.sshKeyId) }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
          );
        }),
      };
    }),
  );
