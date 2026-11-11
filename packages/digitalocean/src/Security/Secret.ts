import * as DO from "@distilled.cloud/digitalocean";
import type { Secret as ApiSecret } from "@distilled.cloud/digitalocean";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type { Providers } from "../Providers.ts";

export type SecretProps = {
  /**
   * Secret name, unique per region. A change replaces the secret.
   *
   * @default a generated physical name
   */
  name?: string;
  /** Region the secret is stored in. A change replaces the secret. @default "nyc3" */
  region?: string;
  /** Key-value pairs to store. A change writes a new version in place. */
  values: Record<string, string | Redacted.Redacted<string>>;
};

export type Secret = Resource<
  "DigitalOcean.Security.Secret",
  SecretProps,
  {
    /** Secret name. */
    name: string;
    /** Region the secret is stored in. */
    region: string;
    /** Current version; each change of `values` writes a new one. */
    version: number;
    /** The stored key-value pairs. */
    values: Redacted.Redacted<Record<string, string>>;
  },
  never,
  Providers
>;

export type SecretAttributes = Secret["Attributes"];

/**
 * A DigitalOcean secret: versioned key-value pairs stored encrypted in one
 * region. Bind it to a runtime with `ReadSecret`. Changing `values` writes a
 * new version in place; `name` and `region` replace the secret.
 *
 * Deleting a secret leaves it pending deletion for a while, and its name
 * stays taken. A deploy that declares a secret pending deletion restores it
 * instead of failing.
 *
 * ### Storing a Secret
 * **Example:** An API key from the environment
 * ```typescript
 * const key = yield* Config.Redacted("STRIPE_KEY");
 * const stripe = yield* DigitalOcean.Security.Secret("stripe", {
 *   region: "nyc3",
 *   values: { STRIPE_KEY: key },
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/Security
 *
 * @resource
 * @product Security
 * @category Security
 */
export const Secret = Resource<Secret>("DigitalOcean.Security.Secret");

const physicalName = (id: string) => createPhysicalName({ id, lowercase: true, maxLength: 63 });

const plainValues = (values: SecretProps["values"]): Record<string, string> =>
  Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      typeof value === "string" ? value : Redacted.value(value),
    ]),
  );

const storedValues = (secret: ApiSecret): Record<string, string> =>
  Object.fromEntries(
    Object.entries(secret.values ?? {}).flatMap(([key, value]) =>
      value === undefined
        ? []
        : [[key, typeof value === "string" ? value : Redacted.value(value)] as const],
    ),
  );

const sameValues = (a: Record<string, string>, b: Record<string, string>) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
};

const toAttrs = (secret: ApiSecret): SecretAttributes => ({
  name: secret.secret,
  region: secret.region,
  version: secret.version,
  values: Redacted.make(storedValues(secret)),
});

const observe = (name: string, region: string) =>
  DO.getSecuritySecret({ secret: name, region }).pipe(
    Effect.asSome,
    Effect.catchTag("NotFound", () => Effect.succeedNone),
  );

export const SecretProvider = () =>
  Provider.succeed(Secret, {
    stables: ["name", "region"],
    nuke: { skip: true },
    read: Effect.fn(function* ({ id, olds, output }) {
      const region = output?.region ?? olds.region ?? "nyc3";
      const name = output?.name ?? olds.name ?? (yield* physicalName(id));
      const observed = yield* observe(name, region);
      if (Option.isNone(observed) || observed.value.delete_requested_at) return undefined;
      const attrs = toAttrs(observed.value);
      // A generated name is this resource's; a chosen one proves nothing.
      return output !== undefined || olds.name === undefined ? attrs : Unowned(attrs);
    }),
    diff: Effect.fn(function* ({ id, olds, news, output }) {
      if (!isResolved(news)) return undefined;
      const region = news.region ?? "nyc3";
      const name = news.name ?? output?.name ?? (yield* physicalName(id));
      if (region !== (olds.region ?? "nyc3") || (output !== undefined && name !== output.name)) {
        return { action: "replace", deleteFirst: news.name !== undefined } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const region = news.region ?? "nyc3";
      const name = news.name ?? output?.name ?? (yield* physicalName(id));
      const desired = plainValues(news.values);

      const observed = yield* observe(name, region);
      if (Option.isNone(observed)) {
        yield* DO.createSecuritySecret({ name, region, values: desired }).pipe(
          // A secret pending deletion still holds the name: take it back.
          Effect.catchTag("SecretPendingDeletion", () =>
            DO.securityPostRestoreSecret({ secret: name, region }),
          ),
        );
      } else if (observed.value.delete_requested_at) {
        yield* DO.securityPostRestoreSecret({ secret: name, region });
      }

      const current = yield* DO.getSecuritySecret({ secret: name, region });
      if (!sameValues(storedValues(current), desired)) {
        yield* DO.updateSecuritySecret({
          secret: name,
          region,
          version: current.version,
          values: desired,
        });
      }
      const final = yield* DO.getSecuritySecret({ secret: name, region });
      return toAttrs(final);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* DO.deleteSecuritySecret({ secret: output.name, region: output.region }).pipe(
        Effect.catchTag(["NotFound", "SecretPendingDeletion"], () => Effect.void),
      );
    }),
  });
