import * as Crypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { gitHubBaseUrlChanged, octokitFor } from "./Octokit.ts";
import type * as GitHub from "./Providers.ts";

export interface DeployKeyProps {
  /** Repository owner (user or organization). */
  owner: string;
  /** Repository name. */
  repository: string;
  /**
   * Whether the key can only read (`git fetch`/`clone`). Set to `false` to
   * allow `git push`. Changing it replaces the key: GitHub keys are
   * immutable.
   * @default true
   */
  readOnly?: boolean;
  /**
   * The key's title in the repository's settings. Changing it replaces the key.
   * @default a name derived from the app, stage and logical ID
   */
  title?: string;
  /**
   * Override the GitHub host or API base URL for this resource only (e.g.
   * `github.example.com` for GitHub Enterprise). Changing it replaces the key.
   */
  baseUrl?: string;
}

export interface DeployKey extends Resource<
  "GitHub.DeployKey",
  DeployKeyProps,
  {
    /** Numeric ID of the key in GitHub. */
    keyId: number;
    /** The key's title. */
    title: string;
    /** Whether the key is read-only. */
    readOnly: boolean;
    /** The public key, in OpenSSH format (`ssh-ed25519 AAAA…`). */
    publicKey: string;
    /** The private key, in OpenSSH format. Generated at deploy time; kept in state. */
    privateKey: Redacted.Redacted<string>;
  },
  never,
  GitHub.Providers
> {}

/**
 * An SSH deploy key on a GitHub repository: git access to exactly one
 * repository, read-only or read-write, without a personal access token.
 *
 * The key pair is generated at deploy time (ed25519) and only its public
 * half is sent to GitHub. The private key is an attribute, so bind it into
 * whatever runs git: `GitHub.MountRepository` creates one for you when
 * no `token` is given.
 *
 * ### Creating a Deploy Key
 * **Example:** A read-write key for a CI runner
 * ```typescript
 * const key = yield* GitHub.DeployKey("ci", {
 *   owner: "acme",
 *   repository: "app",
 *   readOnly: false,
 * });
 * // key.privateKey: Redacted<string> (OpenSSH format)
 * ```
 *
 * @resource
 * @product Deploy Key
 */
export const DeployKey = Resource<DeployKey>("GitHub.DeployKey");

/** An ed25519 key pair in OpenSSH formats. */
const generateKeyPair = (comment: string) => {
  const { publicKey, privateKey } = Crypto.generateKeyPairSync("ed25519");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d!, "base64url");
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  const str = (b: Buffer | string) => {
    const buf = typeof b === "string" ? Buffer.from(b) : b;
    return Buffer.concat([u32(buf.length), buf]);
  };
  const publicBlob = Buffer.concat([str("ssh-ed25519"), str(pub)]);
  const check = u32(Crypto.randomInt(0, 0x1_0000_0000));
  let section = Buffer.concat([
    check,
    check,
    str("ssh-ed25519"),
    str(pub),
    str(Buffer.concat([seed, pub])),
    str(comment),
  ]);
  // Pad to the cipher block size (8 for "none") with 1, 2, 3, …
  const padding = (8 - (section.length % 8)) % 8;
  section = Buffer.concat([section, Buffer.from(Array.from({ length: padding }, (_, i) => i + 1))]);
  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0"),
    str("none"),
    str("none"),
    str(""),
    u32(1),
    str(publicBlob),
    str(section),
  ]).toString("base64");
  return {
    publicKey: `ssh-ed25519 ${publicBlob.toString("base64")} ${comment}`,
    privateKey: [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      ...(body.match(/.{1,70}/g) ?? []),
      "-----END OPENSSH PRIVATE KEY-----",
      "",
    ].join("\n"),
  };
};

/** The key part of an OpenSSH public key (GitHub returns it without the comment). */
const keyMaterial = (key: string) => key.trim().split(/\s+/).slice(0, 2).join(" ");

export const DeployKeyProvider = () =>
  Provider.succeed(DeployKey, {
    stables: ["keyId", "publicKey", "privateKey"],

    // Deploy keys are immutable in GitHub: any change is a new key.
    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return;
      if (olds === undefined) return;
      if (
        news.owner !== olds.owner ||
        news.repository !== olds.repository ||
        (news.readOnly ?? true) !== (output?.readOnly ?? olds.readOnly ?? true) ||
        (news.title !== undefined && news.title !== output?.title) ||
        (yield* gitHubBaseUrlChanged(olds, news))
      ) {
        return { action: "replace" };
      }
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const octokit = yield* octokitFor(news.baseUrl);
      const readOnly = news.readOnly ?? true;
      const title =
        news.title ?? output?.title ?? (yield* createPhysicalName({ id, maxLength: 100 }));

      // Observe — the key we registered, if it still exists.
      const observed = output?.keyId
        ? yield* Effect.tryPromise({
            try: async () => {
              try {
                const { data } = await octokit.rest.repos.getDeployKey({
                  owner: news.owner,
                  repo: news.repository,
                  key_id: output.keyId,
                });
                return data;
              } catch (error: any) {
                if (error.status === 404) return undefined;
                throw error;
              }
            },
            catch: (e) => e as Error,
          })
        : undefined;
      if (observed && output && keyMaterial(observed.key) === keyMaterial(output.publicKey)) {
        return { ...output, title: observed.title, readOnly: observed.read_only };
      }

      // Ensure — register a key pair: the one in state (deleted out of
      // band), else a fresh one. The private key never leaves this machine
      // except into state and the bindings it's given to.
      const pair = output?.privateKey
        ? { publicKey: output.publicKey, privateKey: Redacted.value(output.privateKey) }
        : yield* Effect.sync(() => generateKeyPair(title));
      const { data } = yield* Effect.tryPromise({
        try: () =>
          octokit.rest.repos.createDeployKey({
            owner: news.owner,
            repo: news.repository,
            title,
            key: pair.publicKey,
            read_only: readOnly,
          }),
        catch: (e) =>
          /deploy keys are disabled/i.test(String((e as Error).message))
            ? new Error(
                `Deploy keys are disabled for ${news.owner}/${news.repository}: allow them in the organization's settings (Member privileges → "Deploy keys"), or give the mount a token.`,
              )
            : (e as Error),
      });
      return {
        keyId: data.id,
        title: data.title,
        readOnly: data.read_only,
        publicKey: pair.publicKey,
        privateKey: Redacted.make(pair.privateKey),
      };
    }),

    read: ({ output }) => Effect.succeed(output),

    delete: Effect.fn(function* ({ olds, output }) {
      const octokit = yield* octokitFor(olds.baseUrl);
      yield* Effect.tryPromise({
        try: async () => {
          try {
            await octokit.rest.repos.deleteDeployKey({
              owner: olds.owner,
              repo: olds.repository,
              key_id: output.keyId,
            });
          } catch (error: any) {
            if (error.status !== 404) throw error;
          }
        },
        catch: (e) => e as Error,
      });
    }),
  });
