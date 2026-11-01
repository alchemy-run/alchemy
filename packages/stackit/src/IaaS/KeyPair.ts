import * as iaas from "@distilled.cloud/stackit/iaas";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { hasUnresolvedTrigger } from "../internal/diff.ts";
import { waitUntilGone } from "../internal/wait.ts";
import { desiredLabels, hasAlchemyLabels, stripInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { iaasName, labelsPatch, ownedOnly } from "./internal.ts";

export interface KeyPairProps {
  /**
   * Name of the key pair; servers reference it by name. At most 127
   * characters of `A-Z`, `a-z`, `0-9`, `@`, `.`, `_` and `-`. Changing it
   * replaces the key pair.
   * @default a physical name generated from the app, stage and logical id
   */
  name?: string;
  /**
   * The OpenSSH public key, e.g. `ssh-ed25519 AAAA... user@host`. Only the
   * key type and key data are compared; a different comment does not
   * replace the key pair. Changing the key replaces the key pair.
   */
  publicKey: string;
  /**
   * User labels. Alchemy's ownership labels (`alchemy.stack`,
   * `alchemy.stage`, `alchemy.id`) are added automatically.
   */
  labels?: Record<string, string>;
}

export interface KeyPairAttributes {
  /** Name of the key pair. */
  name: string;
  /** The OpenSSH public key as stored by STACKIT. */
  publicKey: string;
  /** Fingerprint of the public key, computed by STACKIT. */
  fingerprint: string | undefined;
  /** User labels (Alchemy's ownership labels stripped). */
  labels: Record<string, string>;
}

export type KeyPair = Resource<
  "Stackit.IaaS.KeyPair",
  KeyPairProps,
  KeyPairAttributes,
  never,
  Providers
>;

/**
 * A STACKIT SSH key pair: a named public key that servers install for
 * login at creation time.
 *
 * Key pairs belong to the calling user (the service account of the
 * profile), not to a project or region: the same key pair is visible in
 * every project the account can reach. Only labels can be updated in
 * place.
 *
 * ### Registering a key
 * **Example:** An SSH key pair from a public key
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const key = yield* Stackit.IaaS.KeyPair("Deploy", {
 *   publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI... deploy@ci",
 *   labels: { team: "platform" },
 * });
 * ```
 *
 * ### Using it on a server
 * **Example:** Log in to a server with the key pair
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const key = yield* Stackit.IaaS.KeyPair("Deploy", {
 *   publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI... deploy@ci",
 * });
 * const network = yield* Stackit.IaaS.Network("App", {
 *   ipv4: { prefix: "10.0.1.0/24" },
 * });
 * const server = yield* Stackit.IaaS.Server("Web", {
 *   machineType: "g1.1",
 *   bootVolume: { size: 20, source: { type: "image", id: "<ubuntu image id>" } },
 *   networking: { networkId: network.networkId },
 *   keypairName: key.name,
 * });
 * ```
 *
 * ### Replacement
 * Changing `name` or `publicKey` replaces the key pair. Servers only read
 * the key at creation, so existing servers keep the old key. A new key
 * under the same explicit `name` deletes the old key pair first, since
 * names are unique per user.
 *
 * @resource
 * @product STACKIT Compute Engine
 * @category IaaS
 */
export const KeyPair = Resource<KeyPair>("Stackit.IaaS.KeyPair");

/** `type base64` of an OpenSSH public key, without the comment. */
const keyMaterial = (publicKey: string) => publicKey.trim().split(/\s+/).slice(0, 2).join(" ");

const keyName = (id: string, name: string | undefined) =>
  iaasName(id, name).pipe(Effect.map((generated) => generated.slice(0, 127)));

const toAttrs = (keypair: iaas.Keypair, name: string): KeyPairAttributes => ({
  name: keypair.name ?? name,
  publicKey: keypair.publicKey,
  fingerprint: keypair.fingerprint,
  labels: stripInternalLabels(keypair.labels),
});

const getKeyPair = (keypairName: string) =>
  iaas.getKeyPair({ keypairName }).pipe(Effect.catchTag("NotFound", () => Effect.undefined));

export const KeyPairProvider = () =>
  Provider.succeed(KeyPair, {
    stables: ["name"],

    list: Effect.fn(function* () {
      const { items } = yield* iaas.listKeyPairs({});
      return ownedOnly(items).map((keypair) => toAttrs(keypair, keypair.name ?? ""));
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      // Key pair names are unique per user, and an unresolved one can resolve
      // to the current name: the old key pair goes first.
      if (hasUnresolvedTrigger<KeyPairProps>(news, ["name", "publicKey"])) {
        return { action: "replace", deleteFirst: true } as const;
      }
      if (!isResolved(news)) return undefined;
      // An explicit name is the identity; a generated name stays stable
      // until a replacement mints a new one.
      const renamed =
        news.name !== undefined ? news.name !== output.name : olds?.name !== undefined;
      if (renamed) return { action: "replace" } as const;
      const previousKey = olds?.publicKey ?? output.publicKey;
      if (keyMaterial(news.publicKey) !== keyMaterial(previousKey)) {
        // Key pair names are unique per user: under an explicit name the old
        // key pair must go first. A generated name changes with the new
        // generation, so create-before-delete is safe.
        return news.name !== undefined
          ? ({ action: "replace", deleteFirst: true } as const)
          : ({ action: "replace" } as const);
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const name = output?.name ?? (yield* keyName(id, olds?.name));
      const observed = yield* getKeyPair(name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(observed, name);
      return (yield* hasAlchemyLabels(id, observed.labels)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news }) {
      const name = yield* keyName(id, news.name);
      const labels = yield* desiredLabels(id, news.labels);

      // Observe — the name is the identity.
      let current = yield* getKeyPair(name);

      // A key pair cannot change its key: a foreign or stale key under this
      // name is removed so the desired key converges.
      if (current !== undefined && keyMaterial(current.publicKey) !== keyMaterial(news.publicKey)) {
        yield* iaas
          .deleteKeyPair({ keypairName: name })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
        yield* waitUntilGone({
          resource: `STACKIT key pair ${name}`,
          read: getKeyPair(name),
          timeout: "1 minute",
        });
        current = undefined;
      }

      // Ensure — create when missing; a `Conflict` is a concurrent create.
      if (current === undefined) {
        current = yield* iaas
          .createKeyPair({ name, publicKey: news.publicKey, labels })
          .pipe(Effect.catchTag("Conflict", () => iaas.getKeyPair({ keypairName: name })));
      }

      // Sync — labels are the only mutable aspect.
      const labelPatch = labelsPatch(current.labels, labels);
      if (labelPatch !== undefined) {
        current = yield* iaas.updateKeyPair({ keypairName: name, labels: labelPatch });
      }
      return toAttrs(current, name);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* iaas
        .deleteKeyPair({ keypairName: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone({
        resource: `STACKIT key pair ${output.name}`,
        read: getKeyPair(output.name),
        timeout: "1 minute",
      });
    }),
  });
