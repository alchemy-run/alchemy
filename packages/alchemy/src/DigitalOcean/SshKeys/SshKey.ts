import {
  sshKeysCreate,
  sshKeysDelete,
  sshKeysGet,
  sshKeysList,
  sshKeysUpdate,
  type SshKeys as ApiSshKey,
} from "@distilled.cloud/digitalocean/sshKeys";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export type SshKeyProps = {
  /**
   * Display name for the key. Defaults to a generated physical name.
   * Changing it renames the key in place; changing `publicKey` replaces it.
   */
  name?: string;
  /** The public key in `authorized_keys` format (`ssh-ed25519 AAAA… note`). */
  publicKey: string;
};

export type SshKey = Resource<
  "DigitalOcean.SshKey",
  SshKeyProps,
  {
    sshKeyId: number;
    name: string;
    /** MD5 fingerprint DigitalOcean derives from the key material. */
    fingerprint: string;
    publicKey: string;
  },
  never,
  Providers
>;

/**
 * An SSH public key registered on the DigitalOcean team, embedded into the
 * root account of droplets created with it. The key material is the
 * identity: DigitalOcean derives the fingerprint from `publicKey` and
 * rejects duplicates, so changing `publicKey` replaces the resource while
 * `name` updates in place.
 * @resource
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

// Key comparison ignores surrounding whitespace but not the comment field —
// DigitalOcean stores the uploaded string verbatim.
const normalizeKey = (publicKey: string) => publicKey.trim();

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
          Effect.map((r) => Option.fromNullishOr(r.ssh_key)),
          Effect.catchTag("NotFound", () => Effect.succeedNone),
        );

      const listAll = Effect.gen(function* () {
        const out: ApiSshKey[] = [];
        for (let page = 1; ; page++) {
          const res = yield* list({ per_page: 200, page });
          const keys = res.ssh_keys ?? [];
          out.push(...keys);
          if (keys.length < 200) return out;
        }
      });

      /** The key material is the identity — scan for an exact content match. */
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
        list: () => listAll.pipe(Effect.map((keys) => keys.map(toAttrs))),
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

          // Observe — by cached id first, falling back to a content scan so
          // a crash after create (state never persisted) converges on the
          // existing key instead of failing on the duplicate-key 422.
          const cached =
            output !== undefined
              ? yield* observeById(String(output.sshKeyId))
              : Option.none<ApiSshKey>();
          const observed = Option.isSome(cached)
            ? cached
            : yield* observeByContent(publicKey);

          // Ensure — POST registers the key. No AlreadyExists tolerance:
          // sshKeysCreate has no typed duplicate error yet (422 surfaces
          // untyped); the observe above is the idempotency guard.
          if (Option.isNone(observed)) {
            const created = yield* create({
              name: desiredName,
              public_key: publicKey,
            });
            const key = created.ssh_key;
            if (key === undefined) {
              return yield* Effect.die(
                new Error("ssh key create response carried no ssh_key"),
              );
            }
            return toAttrs(key);
          }

          // Sync — the only mutable aspect is the name.
          const key = observed.value;
          if (key.name !== desiredName) {
            const updated = yield* update({
              ssh_key_identifier: String(key.id),
              name: desiredName,
            });
            return toAttrs(updated.ssh_key ?? key);
          }
          return toAttrs(key);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* del({ ssh_key_identifier: String(output.sshKeyId) }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
          );
        }),
        read: Effect.fn(function* ({ olds, output }) {
          if (output !== undefined) {
            const existing = yield* observeById(String(output.sshKeyId));
            return Option.getOrUndefined(Option.map(existing, toAttrs));
          }
          // Content match without cached state: the key material is
          // identical, but we cannot prove we created it — surface as
          // Unowned so a takeover needs an explicit `--adopt` (deleting the
          // stack later deletes the key).
          if (olds?.publicKey === undefined) return undefined;
          const existing = yield* observeByContent(
            normalizeKey(olds.publicKey),
          );
          return Option.getOrUndefined(
            Option.map(existing, (key) => Unowned(toAttrs(key))),
          );
        }),
      };
    }),
  );
