import { Services } from "@distilled.cloud/fly-io";
import type { AddOnsResponseEdgesItemNode } from "@distilled.cloud/fly-io/addons";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../AdoptPolicy.ts";
import * as Binding from "../Binding.ts";
import { deepEqual, isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { createInternalTags } from "../Tags.ts";
import type { App } from "./App.ts";
import { resolveOrgSlug } from "./Environment.ts";
import { createFlyAppName, matchesAlchemyPhysicalName } from "./Metadata.ts";
import type { ServiceBinding } from "./MountVolume.ts";
import type { Providers } from "./Providers.ts";

/** Env-var names Fly.Attach writes onto an App (same as `fly storage create`). */
export const BUCKET_SECRET_NAMES = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_ENDPOINT_URL_S3",
  "AWS_REGION",
  "BUCKET_NAME",
] as const;

export type BucketSecretName = (typeof BUCKET_SECRET_NAMES)[number];

/**
 * Shadow bucket used to migrate from another S3-compatible store.
 * Every field is required when set.
 */
export interface BucketShadow {
  /** Shadow-bucket access key id. */
  accessKey: string;
  /** Shadow-bucket secret. Wrap with `Redacted.make`. */
  secretKey: Redacted.Redacted<string> | string;
  /** Shadow-bucket region. */
  region: string;
  /** Shadow-bucket name. */
  name: string;
  /** Shadow-bucket S3 endpoint URL. */
  endpoint: string;
  /**
   * Dual-write new objects back to the shadow bucket.
   *
   * @default false
   */
  writeThrough?: boolean;
}

export interface BucketProps {
  /**
   * Tigris bucket / add-on name. Globally unique, DNS-compatible
   * (lowercase letters, digits, hyphens), must start with a letter,
   * max 63 characters. If omitted, a unique name is generated from
   * the stack, stage and logical ID. Changing it replaces the Bucket.
   */
  name?: string;
  /**
   * Organization slug. Defaults to the current token's org
   * (`currentTokenShow`). Changing it replaces the Bucket.
   */
  orgSlug?: string;
  /**
   * Serve objects without credentials. Default is private.
   *
   * @default false
   */
  public?: boolean;
  /**
   * Custom domain for public website hosting. Maps to Tigris
   * `options.website.domain_name`. Empty string when omitted
   * (the Tigris API requires the field).
   */
  domainName?: string;
  /**
   * Tigris accelerate. Default is off.
   *
   * @default false
   */
  accelerate?: boolean;
  /**
   * Shadow bucket for zero-downtime migration from another
   * S3-compatible store. Every nested field is required when set.
   */
  shadowBucket?: BucketShadow;
}

export type Bucket = Resource<
  "Fly.Bucket",
  BucketProps,
  {
    /** Fly GraphQL add-on id. Identity of the Bucket. */
    addOnId: string;
    /** Physical Tigris add-on / bucket name. */
    name: string;
    /** Observed provisioning status (`ready`, …). */
    status: string | undefined;
    /** Organization slug. */
    orgSlug: string | undefined;
    /** Whether the bucket is public. */
    public: boolean;
    /** Custom website domain, if set. */
    domainName: string | undefined;
    /** Tigris accelerate. */
    accelerate: boolean;
    /** Tigris SSO dashboard URL, if the API returned one. */
    ssoLink: string | undefined;
    /** RFC3339 creation timestamp. */
    createdAt: string | undefined;
    /**
     * `AWS_ACCESS_KEY_ID` from `createAddOn.environment`. Never logged.
     */
    accessKeyId: Redacted.Redacted<string> | undefined;
    /**
     * `AWS_SECRET_ACCESS_KEY` from `createAddOn.environment`. Never logged.
     */
    secretAccessKey: Redacted.Redacted<string> | undefined;
    /**
     * `AWS_ENDPOINT_URL_S3` from `createAddOn.environment`. Never logged.
     */
    endpoint: Redacted.Redacted<string> | undefined;
    /**
     * `AWS_REGION` from `createAddOn.environment`. Never logged.
     */
    region: Redacted.Redacted<string> | undefined;
    /**
     * `BUCKET_NAME` from `createAddOn.environment`. Never logged.
     */
    bucketName: Redacted.Redacted<string> | undefined;
  },
  never,
  Providers
>;

/**
 * A Fly.Bucket is Tigris S3-compatible object storage, billed through
 * Fly. It is an org-scoped GraphQL add-on (`AddOnType` `tigris`).
 *
 * @resource
 * @see https://fly.io/docs/tigris/
 *
 * @section Create a Bucket
 * Alchemy generates a unique name unless you pass one.
 *
 * @example Generated name
 * ```typescript
 * const data = yield* Fly.Bucket("Data");
 * ```
 *
 * @section A stable name
 * Pass `name` when you need a stable Tigris bucket name.
 *
 * @example Explicit name
 * ```typescript
 * const data = yield* Fly.Bucket("Data", {
 *   name: "my-bucket",
 * });
 * ```
 *
 * :::caution[Changing `name` replaces the Bucket]
 * Tigris cannot rename a bucket. Alchemy creates the new name, then
 * deletes the old one.
 * :::
 *
 * @section Organization
 * Org defaults to the current token. Pass `orgSlug` to pin it.
 *
 * @example Pin an org
 * ```typescript
 * const data = yield* Fly.Bucket("Data", {
 *   orgSlug: "my-org",
 * });
 * ```
 *
 * :::caution[Changing `orgSlug` replaces the Bucket]
 * The bucket is created in the new org. The old bucket is deleted.
 * :::
 *
 * @section Public access
 * Buckets are private by default. `public: true` serves objects
 * without credentials.
 *
 * @example Public bucket
 * ```typescript
 * const assets = yield* Fly.Bucket("Assets", {
 *   public: true,
 * });
 * ```
 *
 * @section Custom domain
 * `domainName` sets `website.domain_name` on the add-on. Point a
 * CNAME at `{name}.t3.tigrisbucket.io`.
 *
 * @example Custom domain
 * ```typescript
 * const assets = yield* Fly.Bucket("Assets", {
 *   public: true,
 *   domainName: "assets.example.com",
 * });
 * ```
 *
 * @section Attach to an App
 * {@link AttachBucket} writes `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
 * `AWS_ENDPOINT_URL_S3`, `AWS_REGION`, and `BUCKET_NAME` onto the
 * {@link App} as {@link Secret}s. A {@link Service} reads them with
 * `Config.redacted`. Do not pass `env: { ... }`.
 *
 * @example Attach from a Service
 * ```typescript
 * import * as Config from "effect/Config";
 * import * as Redacted from "effect/Redacted";
 * import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
 *
 * export default class Api extends Fly.Service<Api>()(
 *   "Api",
 *   { app: Site, main: import.meta.url, port: 3000 },
 *   Effect.gen(function* () {
 *     yield* Fly.AttachBucket(Data);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const bucket = yield* Config.redacted("BUCKET_NAME");
 *         return HttpServerResponse.text(Redacted.value(bucket));
 *       }),
 *     };
 *   }).pipe(Effect.provide(Fly.AttachBucketLive)),
 * ) {}
 * ```
 *
 * @section Attach from a stack
 * Pass the App as the second argument when you are not inside a
 * Service.
 *
 * @example Attach to an App
 * ```typescript
 * yield* Fly.AttachBucket(Data, Site);
 * ```
 *
 * @section Fly.Secret
 * You can also set each key yourself with {@link Secret}.
 *
 * @example Manual secrets
 * ```typescript
 * yield* Fly.Secret("BucketName", {
 *   app: Site,
 *   name: "BUCKET_NAME",
 *   value: Data.bucketName,
 * });
 * ```
 */
export const Bucket = Resource<Bucket>("Fly.Bucket");

export class BucketNotCreated extends Data.TaggedError("Fly.BucketNotCreated")<{
  name: string;
}> {}

export class BucketOrgMissing extends Data.TaggedError("Fly.BucketOrgMissing")<{
  orgSlug: string;
}> {}

export class BucketProvisionFailed extends Data.TaggedError(
  "Fly.BucketProvisionFailed",
)<{
  name: string;
  status: string | undefined;
  errorMessage: string | undefined;
}> {}

export class BucketAttachAppMissing extends Data.TaggedError(
  "Fly.BucketAttachAppMissing",
)<{
  message: string;
}> {}

export class BucketCredentialsMissing extends Data.TaggedError(
  "Fly.BucketCredentialsMissing",
)<{
  name: string;
}> {}

class BucketPending extends Data.TaggedError("Fly.BucketPending")<{
  name: string;
  status: string;
}> {}

const TIGRIS = "tigris" as const;

const backoff = Schedule.min([
  Schedule.exponential(Duration.millis(500), 1.5),
  Schedule.spaced(Duration.seconds(5)),
]);

const sanitizeFlyBucketName = (name: string): string => {
  const lowered = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  const clipped =
    lowered.length > 63 ? lowered.slice(0, 63).replace(/-+$/g, "") : lowered;
  const raw = clipped.length === 0 ? "f" : clipped;
  return /^[a-z]/.test(raw) ? raw : `f${raw}`.slice(0, 63);
};

const resolveBucketName = (
  id: string,
  name: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (name !== undefined) return sanitizeFlyBucketName(name);
    if (existing !== undefined) return existing;
    return yield* createFlyAppName(id);
  });

const asRecord = (value: unknown): Record<string, unknown> => {
  if (Redacted.isRedacted(value)) {
    return asRecord(Redacted.value(value));
  }
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
};

const asString = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    return value.length > 0 ? value : undefined;
  }
  if (Redacted.isRedacted(value)) {
    return asString(Redacted.value(value));
  }
  return undefined;
};

const redact = (
  value: string | undefined,
): Redacted.Redacted<string> | undefined =>
  value !== undefined && value.length > 0 ? Redacted.make(value) : undefined;

const keepSecret = (
  next: Redacted.Redacted<string> | undefined,
  previous: Redacted.Redacted<string> | undefined,
): Redacted.Redacted<string> | undefined => next ?? previous;

const envString = (
  env: Record<string, unknown>,
  key: BucketSecretName,
): string | undefined => asString(env[key]);

type ObservedAddOn = Pick<
  AddOnsResponseEdgesItemNode,
  | "id"
  | "name"
  | "status"
  | "errorMessage"
  | "environment"
  | "options"
  | "metadata"
  | "ssoLink"
  | "createdAt"
> & {
  organization?: { slug?: string | null; rawSlug?: string } | null;
};

const unwrapSecret = (value: Redacted.Redacted<string> | string): string =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

const desiredOptions = (props: BucketProps): Record<string, unknown> => {
  const options: Record<string, unknown> = {
    public: props.public ?? false,
    accelerate: props.accelerate ?? false,
    website: { domain_name: props.domainName ?? "" },
  };
  if (props.shadowBucket !== undefined) {
    options.shadow_bucket = {
      access_key: props.shadowBucket.accessKey,
      secret_key: unwrapSecret(props.shadowBucket.secretKey),
      region: props.shadowBucket.region,
      name: props.shadowBucket.name,
      endpoint: props.shadowBucket.endpoint,
      write_through: props.shadowBucket.writeThrough ?? false,
    };
  }
  return options;
};

const websiteDomain = (
  options: Record<string, unknown>,
): string | undefined => {
  const website = asRecord(options.website);
  return asString(website.domain_name);
};

const toAttrs = (
  addOn: ObservedAddOn,
  previous?: Bucket["Attributes"],
  fallback?: { name?: string; orgSlug?: string },
): Bucket["Attributes"] => {
  const options = asRecord(addOn.options);
  const env = asRecord(addOn.environment);
  const name = addOn.name ?? fallback?.name ?? previous?.name ?? "";
  const orgSlug =
    asString(addOn.organization?.slug) ??
    asString(addOn.organization?.rawSlug) ??
    fallback?.orgSlug ??
    previous?.orgSlug;
  return {
    addOnId: addOn.id,
    name,
    status: addOn.status ?? undefined,
    orgSlug,
    public:
      typeof options.public === "boolean"
        ? options.public
        : (previous?.public ?? false),
    domainName: websiteDomain(options),
    accelerate: options.accelerate === true,
    ssoLink: addOn.ssoLink ?? undefined,
    createdAt: addOn.createdAt,
    accessKeyId: keepSecret(
      redact(envString(env, "AWS_ACCESS_KEY_ID")),
      previous?.accessKeyId,
    ),
    secretAccessKey: keepSecret(
      redact(envString(env, "AWS_SECRET_ACCESS_KEY")),
      previous?.secretAccessKey,
    ),
    endpoint: keepSecret(
      redact(envString(env, "AWS_ENDPOINT_URL_S3")),
      previous?.endpoint,
    ),
    region: keepSecret(redact(envString(env, "AWS_REGION")), previous?.region),
    bucketName: keepSecret(
      redact(envString(env, "BUCKET_NAME") ?? name),
      previous?.bucketName,
    ),
  };
};

const stringRecordOf = (value: unknown): Record<string, string> =>
  Object.fromEntries(
    Object.entries(asRecord(value)).flatMap(([key, item]) => {
      const text = asString(item);
      return text !== undefined ? [[key, text]] : [];
    }),
  );

const hasAlchemyMetadata = (metadata: unknown): boolean => {
  const tags = stringRecordOf(metadata);
  const stack = tags["alchemy::stack"] ?? tags["alchemy.stack"];
  return stack !== undefined && stack.length > 0;
};

const isOwnedAddOn = (addOn: ObservedAddOn): boolean =>
  matchesAlchemyPhysicalName(addOn.name ?? undefined) ||
  hasAlchemyMetadata(addOn.metadata);

export const listTigrisAddOns = Effect.fn(function* () {
  const rows: AddOnsResponseEdgesItemNode[] = [];
  let after: string | undefined;
  for (let i = 0; i < 8; i++) {
    const page = yield* Services.addons.addOns({
      type: TIGRIS,
      first: 50,
      after,
    });
    for (const edge of page.edges ?? []) {
      if (edge?.node != null) rows.push(edge.node);
    }
    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor ?? undefined;
    if (after === undefined || after.length === 0) break;
  }
  return rows;
});

const findById = (addOnId: string) =>
  listTigrisAddOns().pipe(
    Effect.map((addOns) => addOns.find((addOn) => addOn.id === addOnId)),
  );

const findByName = (name: string) =>
  listTigrisAddOns().pipe(
    Effect.map((addOns) => addOns.find((addOn) => addOn.name === name)),
  );

const failedStatus = (status: string | undefined) =>
  status === "error" || status === "failed";

const pendingStatus = (status: string | undefined) =>
  status === "creating" ||
  status === "provisioning" ||
  status === "pending" ||
  status === "pending_create";

const waitUntilReady = (name: string, addOnId: string) =>
  findById(addOnId).pipe(
    Effect.flatMap((addOn) => {
      if (addOn === undefined) {
        return Effect.fail(new BucketPending({ name, status: "missing" }));
      }
      const status = addOn.status ?? undefined;
      if (failedStatus(status)) {
        return new BucketProvisionFailed({
          name,
          status,
          errorMessage: addOn.errorMessage ?? undefined,
        });
      }
      if (pendingStatus(status)) {
        return Effect.fail(
          new BucketPending({ name, status: status ?? "creating" }),
        );
      }
      return Effect.succeed(addOn);
    }),
    Effect.retry({
      while: (e) => e._tag === "Fly.BucketPending",
      times: 8,
      schedule: backoff,
    }),
    Effect.catchTag("Fly.BucketPending", () => findById(addOnId)),
  );

const waitUntilGone = (addOnId: string, name: string) =>
  findById(addOnId).pipe(
    Effect.map((addOn) => addOn === undefined),
    Effect.flatMap((goneById) =>
      goneById
        ? Effect.succeed(true)
        : findByName(name).pipe(Effect.map((addOn) => addOn === undefined)),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (gone) => gone,
      times: 10,
    }),
  );

const resolveOrganization = (orgSlug: string) =>
  Services.addons
    .organization({ slug: orgSlug })
    .pipe(Effect.catchTag("FlyIoParseError", () => Effect.succeed(undefined)));

const ensureTos = (orgSlug: string, organizationId: string) =>
  Effect.gen(function* () {
    const agreed = yield* Services.addons.agreedToProviderTos({
      slug: orgSlug,
      providerName: TIGRIS,
    });
    if (agreed === true) return;
    const tos = yield* Effect.result(
      Services.addons.createExtensionTosAgreement({
        input: {
          addOnProviderName: TIGRIS,
          organizationId,
        },
      }),
    );
    if (Result.isFailure(tos)) return;
  });

const optionsEqual = (
  observed: Record<string, unknown>,
  desired: Record<string, unknown>,
): boolean => {
  const observedPublic = observed.public === true;
  const desiredPublic = desired.public === true;
  const observedAccelerate = observed.accelerate === true;
  const desiredAccelerate = desired.accelerate === true;
  const observedDomain = websiteDomain(observed) ?? "";
  const desiredDomain = websiteDomain(desired) ?? "";
  if (
    observedPublic !== desiredPublic ||
    observedAccelerate !== desiredAccelerate ||
    observedDomain !== desiredDomain
  ) {
    return false;
  }
  if (desired.shadow_bucket !== undefined) {
    return deepEqual(asRecord(observed.shadow_bucket), desired.shadow_bucket);
  }
  return true;
};

export const BucketProvider = () =>
  Provider.succeed(Bucket, {
    stables: ["addOnId", "name", "orgSlug"],

    diff: Effect.fn(function* ({ news, output }) {
      if (news === undefined || !isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      const desiredName =
        news.name !== undefined
          ? sanitizeFlyBucketName(news.name)
          : output.name;
      const nameChanged = desiredName !== output.name;
      const orgChanged =
        news.orgSlug !== undefined && news.orgSlug !== output.orgSlug;
      if (nameChanged || orgChanged) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const name = yield* resolveBucketName(id, olds?.name, output?.name);
      const found =
        (output?.addOnId !== undefined && output.addOnId.length > 0
          ? yield* findById(output.addOnId)
          : undefined) ?? (yield* findByName(name));
      if (found === undefined) return undefined;
      const attrs = toAttrs(found, output, {
        name,
        orgSlug: output?.orgSlug ?? olds?.orgSlug,
      });
      if (output !== undefined) return attrs;
      return isOwnedAddOn(found) ? attrs : Unowned(attrs);
    }),

    list: Effect.fn(function* () {
      const addOns = yield* listTigrisAddOns();
      return addOns.flatMap((addOn) =>
        isOwnedAddOn(addOn) ? [toAttrs(addOn)] : [],
      );
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const props = news ?? ({} as BucketProps);
      const name = yield* resolveBucketName(id, props.name, output?.name);
      const orgSlug =
        props.orgSlug ?? output?.orgSlug ?? (yield* resolveOrgSlug());

      // Observe by cached id, then the desired name.
      let current: ObservedAddOn | undefined =
        output?.addOnId !== undefined && output.addOnId.length > 0
          ? yield* findById(output.addOnId)
          : undefined;
      if (current === undefined) {
        current = yield* findByName(name);
      }

      const org = yield* resolveOrganization(orgSlug);
      if (org === undefined) {
        return yield* new BucketOrgMissing({ orgSlug });
      }

      if (current === undefined) {
        yield* ensureTos(orgSlug, org.id);
        const created = yield* Effect.result(
          Services.addons.createAddOn({
            input: {
              type: TIGRIS,
              name,
              organizationId: org.id,
              options: desiredOptions(props),
            },
          }),
        );
        if (Result.isSuccess(created)) {
          current = created.success.addOn;
        } else {
          current = yield* findByName(name);
          if (current === undefined) {
            return yield* Effect.fail(created.failure);
          }
        }
        if (current.id.length > 0) {
          current = (yield* waitUntilReady(name, current.id)) ?? current;
        }
      }

      if (current === undefined || current.id.length === 0) {
        return yield* new BucketNotCreated({ name });
      }

      const status = current.status ?? undefined;
      if (failedStatus(status)) {
        return yield* new BucketProvisionFailed({
          name,
          status,
          errorMessage: current.errorMessage ?? undefined,
        });
      }

      const observedOptions = asRecord(current.options);
      const desired = desiredOptions(props);
      const internal = yield* createInternalTags(id);
      const observedMeta = stringRecordOf(current.metadata);
      const nextMeta = { ...observedMeta, ...internal };
      const optionsChanged = !optionsEqual(observedOptions, desired);
      const metaChanged = !deepEqual(observedMeta, nextMeta);
      if (optionsChanged || metaChanged) {
        const nextOptions = {
          ...observedOptions,
          ...desired,
        };
        const updated = yield* Effect.result(
          Services.addons.updateAddOn({
            input: {
              addOnId: current.id,
              options: optionsChanged ? nextOptions : undefined,
              metadata: metaChanged ? nextMeta : undefined,
            },
          }),
        );
        if (Result.isSuccess(updated)) {
          current = {
            ...current,
            ...updated.success.addOn,
          };
        } else {
          current = (yield* findById(current.id)) ?? current;
        }
      }

      const latest = (yield* findById(current.id)) ?? current;
      const attrs = toAttrs(latest, output, { name, orgSlug });
      const observedPublic = asRecord(latest.options).public;
      return {
        ...attrs,
        public:
          typeof observedPublic === "boolean"
            ? observedPublic
            : (props.public ?? attrs.public),
        domainName:
          websiteDomain(asRecord(latest.options)) ??
          props.domainName ??
          attrs.domainName,
        accelerate:
          typeof asRecord(latest.options).accelerate === "boolean"
            ? (asRecord(latest.options).accelerate as boolean)
            : (props.accelerate ?? attrs.accelerate),
      };
    }),

    delete: Effect.fn(function* ({ output }) {
      const addOnId = output.addOnId;
      const name = output.name;
      if (addOnId.length === 0 && name.length === 0) return;
      const deleted = yield* Effect.result(
        Services.addons.deleteAddOn({
          input: addOnId.length > 0 ? { addOnId } : { name, provider: TIGRIS },
        }),
      );
      if (Result.isFailure(deleted)) {
        const still = yield* findById(addOnId);
        const stillNamed =
          still === undefined && name.length > 0
            ? yield* findByName(name)
            : still;
        if (stillNamed !== undefined) {
          return yield* Effect.fail(deleted.failure);
        }
        return;
      }
      yield* waitUntilGone(addOnId, name);
    }),
  });

const isFlyHost = (
  value: unknown,
): value is Resource<string, any, any, ServiceBinding> =>
  typeof value === "object" &&
  value !== null &&
  ((value as { Type?: string }).Type === "Fly.Service" ||
    (value as { Type?: string }).Type === "Fly.Machine");

const toName = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const readAttr = (value: unknown): Effect.Effect<unknown> =>
  Effect.gen(function* () {
    if (
      value == null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      Redacted.isRedacted(value)
    ) {
      return value;
    }
    return yield* value as Effect.Effect<unknown>;
  });

const secretValueOf = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    return value.length > 0 ? value : undefined;
  }
  if (Redacted.isRedacted(value)) {
    return secretValueOf(Redacted.value(value));
  }
  return undefined;
};

const resolveAttachAppName = (app: App | undefined) =>
  Effect.gen(function* () {
    if (app !== undefined) {
      const name = toName(yield* readAttr(app.appName));
      if (name !== undefined) return name;
      const nested = toName(
        yield* readAttr((app as { appName?: unknown }).appName),
      );
      if (nested !== undefined) return nested;
    }
    const host = yield* Binding.Host;
    if (isFlyHost(host)) {
      const name = toName(
        yield* readAttr((host as { appName: unknown }).appName),
      );
      if (name !== undefined) return name;
    }
    return yield* new BucketAttachAppMissing({
      message:
        "Fly.AttachBucket requires a Fly.App (pass it as the second argument) or a Fly.Service / Fly.Machine host.",
    });
  });

const putSecretValues = (appName: string, values: Record<string, string>) =>
  Effect.gen(function* () {
    if (Object.keys(values).length === 0) return;
    const updated = yield* Effect.result(
      Services.machines.secretsUpdate({
        app_name: appName,
        values,
      }),
    );
    if (Result.isSuccess(updated)) return;
    for (const [secretName, value] of Object.entries(values)) {
      yield* Services.machines
        .secretCreate({
          app_name: appName,
          secret_name: secretName,
          value,
        })
        .pipe(Effect.catchTag("Conflict", () => Effect.void));
    }
  });

const envValuesOf = (addOn: ObservedAddOn): Record<string, string> => {
  const env = asRecord(addOn.environment);
  const values: Record<string, string> = {};
  for (const key of BUCKET_SECRET_NAMES) {
    const value = envString(env, key);
    if (value !== undefined) values[key] = value;
  }
  if (values.BUCKET_NAME === undefined && addOn.name != null) {
    values.BUCKET_NAME = addOn.name;
  }
  return values;
};

/**
 * Write Tigris `AWS_*` / `BUCKET_NAME` secrets onto an App. Called from
 * {@link Service} reconcile so the secrets exist before Machines boot.
 */
export const attachBucketSecrets = Effect.fn(function* (
  appName: string,
  attached: readonly { name: string }[],
) {
  if (appName.length === 0 || attached.length === 0) return;
  for (const item of attached) {
    const name = item.name;
    if (name.length === 0) continue;
    const listed = yield* findByName(name);
    const detail =
      listed !== undefined
        ? yield* Services.addons
            .addOn({
              id: listed.id,
              name,
              provider: TIGRIS,
            })
            .pipe(
              Effect.catchTag("FlyIoParseError", () =>
                Effect.succeed(undefined),
              ),
            )
        : undefined;
    const row = detail ?? listed;
    if (row === undefined) continue;
    yield* putSecretValues(appName, envValuesOf(row));
  }
});

const writeBucketSecrets = (appName: string, bucket: Bucket) =>
  Effect.gen(function* () {
    const accessKeyId = secretValueOf(yield* readAttr(bucket.accessKeyId));
    const secretAccessKey = secretValueOf(
      yield* readAttr(bucket.secretAccessKey),
    );
    const endpoint = secretValueOf(yield* readAttr(bucket.endpoint));
    const region = secretValueOf(yield* readAttr(bucket.region));
    const bucketName =
      secretValueOf(yield* readAttr(bucket.bucketName)) ??
      toName(yield* readAttr(bucket.name));
    const values: Record<string, string> = {};
    if (accessKeyId !== undefined) values.AWS_ACCESS_KEY_ID = accessKeyId;
    if (secretAccessKey !== undefined) {
      values.AWS_SECRET_ACCESS_KEY = secretAccessKey;
    }
    if (endpoint !== undefined) values.AWS_ENDPOINT_URL_S3 = endpoint;
    if (region !== undefined) values.AWS_REGION = region;
    if (bucketName !== undefined) values.BUCKET_NAME = bucketName;
    if (Object.keys(values).length === 0) {
      const name = toName(yield* readAttr(bucket.name)) ?? "";
      return yield* new BucketCredentialsMissing({ name });
    }
    yield* putSecretValues(appName, values);
  });

/**
 * Writes Tigris credentials onto a Fly.App as App secrets.
 *
 * The Service reads them with `Config.redacted`. Do not pass
 * `env: { ... }` on the Service.
 *
 * @binding
 *
 * @section Attach from a Service
 * Yield `AttachBucket` in init. Provide {@link AttachBucketLive}. Fly
 * injects the secrets as environment variables on every Machine.
 *
 * @example On a Service
 * ```typescript
 * import * as Config from "effect/Config";
 * import * as Redacted from "effect/Redacted";
 * import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
 *
 * export default class Api extends Fly.Service<Api>()(
 *   "Api",
 *   { app: Site, main: import.meta.url, port: 3000 },
 *   Effect.gen(function* () {
 *     yield* Fly.AttachBucket(Data);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const bucket = yield* Config.redacted("BUCKET_NAME");
 *         return HttpServerResponse.text(Redacted.value(bucket));
 *       }),
 *     };
 *   }).pipe(Effect.provide(Fly.AttachBucketLive)),
 * ) {}
 * ```
 *
 * @section Attach to an App
 * Pass the App when you are not inside a Service.
 *
 * @example On a stack
 * ```typescript
 * yield* Fly.AttachBucket(Data, Site);
 * ```
 */
export interface AttachBucket extends Binding.Service<
  AttachBucket,
  "Fly.Bucket.Attach",
  (bucket: Bucket, app?: App) => Effect.Effect<void>
> {}

export const AttachBucket = Binding.Service<AttachBucket>("Fly.Bucket.Attach");

/**
 * Deploy-time implementation of {@link AttachBucket}. Provide it on the
 * {@link Service} Effect, or rely on {@link providers}.
 *
 * @layer
 * @provides Fly.Bucket.Attach
 *
 * @section Provide the layer
 * @example On a Service
 * ```typescript
 * Effect.gen(function* () {
 *   yield* Fly.AttachBucket(Data);
 * }).pipe(Effect.provide(Fly.AttachBucketLive))
 * ```
 */
export const AttachBucketLive = Layer.effect(
  AttachBucket,
  Effect.succeed(
    Effect.fn(function* (bucket: Bucket, app?: App) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFlyHost(host)) {
          yield* host.bind`${bucket}`({
            bucket: { name: bucket.name },
          });
        }
        if (app !== undefined) {
          const appName = yield* resolveAttachAppName(app);
          yield* writeBucketSecrets(appName, bucket);
        }
      }
    }),
  ),
);
