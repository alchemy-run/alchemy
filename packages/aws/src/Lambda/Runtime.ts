import * as Lambda from "@distilled.cloud/aws/lambda";
import * as lambdacore from "@distilled.cloud/aws/lambda-core";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { createInternalTags, diffTags, hasAlchemyTags } from "alchemy/Tags";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { AWSEnvironment } from "../Environment.ts";
import { normalizePolicyDocument, type PolicyDocument } from "../IAM/Policy.ts";
import { partitionOf } from "../Partition.ts";
import type { Providers } from "../Providers.ts";
import {
  fromLifecycle,
  lifecycleEqual,
  recoveryWindowOf,
  toLifecycle,
} from "./RuntimeLifecycle.ts";

/**
 * When a customer-managed runtime, runtime version or runtime alias stops
 * being usable. Lambda blocks new functions on `functionCreateBlockDate`
 * and updates to existing functions on `functionUpdateBlockDate`;
 * invocations keep working.
 */
export interface RuntimeReleaseLifecycle {
  /**
   * The release state shown to consumers. `DEPRECATED` needs a
   * `deprecationDate` on or before today (UTC); `PREVIEW` and `GA` need a
   * later one, or none.
   */
  releaseState?: "PREVIEW" | "GA" | "DEPRECATED";
  /** The date (UTC, `YYYY-MM-DD`) the runtime or alias becomes deprecated. */
  deprecationDate?: string;
  /** The date (UTC, `YYYY-MM-DD`) from which new functions can't use it. */
  functionCreateBlockDate?: string;
  /** The date (UTC, `YYYY-MM-DD`) from which functions using it can't be updated. */
  functionUpdateBlockDate?: string;
}

/**
 * Who may build functions on a runtime. Lambda checks it when a function
 * in another account is created on, or switched to, one of the runtime's
 * aliases. Functions already on the runtime keep running when access is
 * removed.
 */
export interface RuntimeSharing {
  /** AWS account IDs that may use the runtime. */
  accounts?: string[];
  /** An AWS Organizations ID (`o-…`); every account in it may use the runtime. */
  organizationId?: string;
  /**
   * Organizational unit paths (`aws:PrincipalOrgPaths`), e.g.
   * `"o-a1b2c3d4e5/r-ab12/ou-ab12-11111111/*"` for an OU and its children.
   */
  organizationalUnitPaths?: string[];
  /** Let every AWS account use the runtime. */
  public?: boolean;
  /**
   * The aliases consumers may use. Omit to share every alias and let
   * consumers pin functions to any version.
   */
  aliases?: string[];
}

export interface RuntimeProps {
  /**
   * The runtime name: 2–128 lowercase letters, numbers, `-`, `_` and `.`.
   * If omitted, a unique name is generated. Changing it replaces the
   * runtime.
   */
  name?: string;
  /** What the runtime is for and what it contains, shown to consumers. */
  description?: string;
  /** The licenses of the software in the runtime, shown to consumers. */
  licenseInfo?: string;
  /**
   * Deprecation dates for the runtime. Aliases inherit them unless they set
   * their own. Omit to clear them.
   */
  releaseLifecycle?: RuntimeReleaseLifecycle;
  /**
   * Accounts, organizations or OUs outside this account that may build
   * functions on the runtime. Alchemy writes it as the runtime's
   * resource-based policy. Omit to share with no one.
   */
  sharing?: RuntimeSharing;
  /**
   * Days (7–30) Lambda keeps the runtime restorable after Alchemy deletes
   * it. The name stays reserved for that long. Alchemy restores its own
   * runtime when it deploys the same name again within the window.
   * @default 30
   */
  recoveryWindowInDays?: number;
  /** Tags to apply to the runtime. */
  tags?: Record<string, string>;
}

export interface Runtime extends Resource<
  "AWS.Lambda.Runtime",
  RuntimeProps,
  {
    /** The runtime ARN, which functions reference. */
    runtimeArn: string;
    /** The runtime name. */
    runtimeName: string;
    /** The runtime description. */
    description?: string;
    /** The runtime license information. */
    licenseInfo?: string;
    /** The runtime's deprecation dates. */
    releaseLifecycle?: RuntimeReleaseLifecycle;
    /** The runtime state, e.g. `ACTIVE` or `PENDING_DELETION`. */
    state?: string;
  },
  never,
  Providers,
  RuntimeLookup
> {}

/**
 * Props for {@link Runtime.lookup}: find a runtime this stack doesn't manage.
 * A runtime shared from another account is found by its ARN.
 */
export type RuntimeLookup =
  | {
      /** The runtime ARN, which may be in another account. */
      runtimeArn: string;
    }
  | {
      /** The name of a runtime in the ambient account and region. */
      name: string;
    };

/**
 * A Lambda customer-managed runtime: a runtime you build from a container
 * image and patch on your own schedule, in place of a Lambda-managed one
 * like `nodejs24.x`.
 *
 * A runtime holds immutable {@link RuntimeVersion}s, each made from one
 * container image, and {@link RuntimeAlias}es, named pointers to a version.
 * Functions run on an alias. Pointing the alias at a new version rolls the
 * update out to every function on it at its next cold start, without
 * redeploying them.
 *
 * Lambda never deletes a runtime right away. Deleting it schedules
 * deletion after `recoveryWindowInDays` (7–30), and the name stays
 * reserved until then.
 *
 * ### Publishing a runtime
 * **Example:** A runtime with one version and a `prod` alias
 * ```typescript
 * const runtime = yield* AWS.Lambda.Runtime("Node", {
 *   description: "Node.js 24 with the company CA bundle",
 * });
 * const v1 = yield* AWS.Lambda.RuntimeVersion("NodeV1", {
 *   runtime,
 *   context: "./runtime",
 * });
 * const prod = yield* AWS.Lambda.RuntimeAlias("NodeProd", {
 *   version: v1,
 *   name: "prod",
 * });
 * ```
 *
 * ### Sharing a runtime
 * **Example:** Let every account in an organization use the runtime
 * ```typescript
 * const runtime = yield* AWS.Lambda.Runtime("Node", {
 *   sharing: { organizationId: "o-a1b2c3d4e5" },
 * });
 * ```
 *
 * **Example:** Share only the `prod` alias with two accounts
 * ```typescript
 * const runtime = yield* AWS.Lambda.Runtime("Node", {
 *   sharing: {
 *     accounts: ["111122223333", "444455556666"],
 *     aliases: ["prod"],
 *   },
 * });
 * ```
 *
 * ### Scheduling deprecation
 * **Example:** Block new functions after a date
 * ```typescript
 * const runtime = yield* AWS.Lambda.Runtime("Node", {
 *   releaseLifecycle: {
 *     releaseState: "GA",
 *     deprecationDate: "2027-06-30",
 *     functionCreateBlockDate: "2027-06-30",
 *     functionUpdateBlockDate: "2027-09-30",
 *   },
 * });
 * ```
 *
 * ### Looking up a shared runtime
 * `Runtime.lookup` references a runtime Alchemy doesn't manage, such as one
 * a platform team shares from another account. It is read during plan and
 * deploy and never created, updated or deleted.
 *
 * **Example:** Reference a runtime from another account
 * ```typescript
 * const runtime = AWS.Lambda.Runtime.lookup({
 *   runtimeArn: "arn:aws:lambda:us-east-1:123456789012:runtime/companynode",
 * });
 * ```
 *
 * @resource
 */
export const Runtime = Resource<Runtime>("AWS.Lambda.Runtime");

/** The name is reserved by a runtime Alchemy doesn't own that is pending deletion. */
export class RuntimeNameReserved extends Data.TaggedError("RuntimeNameReserved")<{
  readonly message: string;
}> {}

const resolveRuntimeName = (id: string, name: string | undefined) =>
  name
    ? Effect.succeed(name)
    : createPhysicalName({ id, maxLength: 128, delimiter: "-", lowercase: true });

const getRuntime = (identifier: string) =>
  lambdacore
    .getRuntime({ RuntimeName: identifier })
    .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.undefined));

const observedTags = (arn: string) =>
  Lambda.listTags({ Resource: arn }).pipe(
    Effect.map((r) =>
      Object.fromEntries(
        Object.entries(r.Tags ?? {}).flatMap(([key, value]) =>
          value === undefined ? [] : [[key, value] as const],
        ),
      ),
    ),
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed({} as Record<string, string>),
    ),
  );

/** The resource-based policy that grants `sharing`, or `undefined` for none. */
const sharingPolicy = (
  runtimeArn: string,
  sharing: RuntimeSharing | undefined,
  partition: string,
): PolicyDocument | undefined => {
  if (sharing === undefined) return undefined;
  const aliasResources =
    sharing.aliases === undefined
      ? [`${runtimeArn}/alias/*`]
      : sharing.aliases.map((alias) => `${runtimeArn}/alias/${alias}`);
  const versionResources = [`${runtimeArn}/version/*`];
  const actions = [
    "lambda:AssociateRuntimeAlias",
    ...(sharing.aliases === undefined ? ["lambda:AssociateRuntimeVersion"] : []),
    "lambda:GetRuntime",
    "lambda:GetRuntimeAlias",
    "lambda:ListRuntimeAliases",
    "lambda:GetRuntimeVersion",
    "lambda:ListRuntimeVersions",
  ];
  const resources = [runtimeArn, ...aliasResources, ...versionResources];
  const statements: PolicyDocument["Statement"] = [];
  if (sharing.accounts !== undefined && sharing.accounts.length > 0) {
    statements.push({
      Sid: "AlchemyShareWithAccounts",
      Effect: "Allow",
      Principal: {
        AWS: sharing.accounts.map((account) => `arn:${partition}:iam::${account}:root`),
      },
      Action: actions,
      Resource: resources,
    });
  }
  if (sharing.organizationId !== undefined) {
    statements.push({
      Sid: "AlchemyShareWithOrganization",
      Effect: "Allow",
      Principal: "*",
      Action: actions,
      Resource: resources,
      Condition: { StringEquals: { "aws:PrincipalOrgID": sharing.organizationId } },
    });
  }
  if (sharing.organizationalUnitPaths !== undefined && sharing.organizationalUnitPaths.length > 0) {
    statements.push({
      Sid: "AlchemyShareWithOrganizationalUnits",
      Effect: "Allow",
      Principal: "*",
      Action: actions,
      Resource: resources,
      Condition: {
        "ForAnyValue:StringLike": { "aws:PrincipalOrgPaths": sharing.organizationalUnitPaths },
      },
    });
  }
  if (sharing.public === true) {
    statements.push({
      Sid: "AlchemySharePublicly",
      Effect: "Allow",
      Principal: "*",
      Action: actions,
      Resource: resources,
    });
  }
  return statements.length === 0 ? undefined : { Version: "2012-10-17", Statement: statements };
};

const readPolicy = (runtimeArn: string) =>
  Lambda.getResourcePolicy({ ResourceArn: runtimeArn }).pipe(
    Effect.map((r) => r.Policy),
    Effect.catchTag("ResourceNotFoundException", () => Effect.undefined),
  );

const syncPolicy = Effect.fn(function* (runtimeArn: string, sharing: RuntimeSharing | undefined) {
  const { region } = yield* AWSEnvironment.current;
  const desired = sharingPolicy(runtimeArn, sharing, partitionOf(region));
  const observed = yield* readPolicy(runtimeArn);
  if (desired === undefined) {
    if (observed !== undefined) {
      yield* Lambda.deleteResourcePolicy({ ResourceArn: runtimeArn }).pipe(
        Effect.catchTag("ResourceNotFoundException", () => Effect.void),
      );
    }
    return;
  }
  if (
    observed === undefined ||
    normalizePolicyDocument(observed) !== normalizePolicyDocument(desired)
  ) {
    yield* Lambda.putResourcePolicy({ ResourceArn: runtimeArn, Policy: JSON.stringify(desired) });
  }
});

const toAttrs = (runtime: lambdacore.GetRuntimeResponse): Runtime["Attributes"] => ({
  runtimeArn: runtime.Arn,
  runtimeName: runtime.Name,
  description: runtime.Description || undefined,
  licenseInfo: runtime.LicenseInfo || undefined,
  releaseLifecycle: fromLifecycle(runtime.ReleaseLifecycle),
  state: runtime.State,
});

export const RuntimeProvider = () =>
  Provider.succeed(Runtime, {
    stables: ["runtimeArn", "runtimeName"],

    diff: Effect.fn(function* ({ id, olds, news, output }) {
      if (!isResolved(news)) return;
      // Prefer the deployed name: the generator may drift, the runtime never
      // renames.
      const oldName = output?.runtimeName ?? (yield* resolveRuntimeName(id, olds.name));
      const newName =
        news.name ?? output?.runtimeName ?? (yield* resolveRuntimeName(id, undefined));
      if (oldName !== newName) {
        return { action: "replace" } as const;
      }
    }),

    lookup: Effect.fn(function* (props) {
      const runtime = yield* getRuntime("runtimeArn" in props ? props.runtimeArn : props.name);
      return runtime ? toAttrs(runtime) : undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const name = output?.runtimeName ?? (yield* resolveRuntimeName(id, olds?.name));
      const runtime = yield* getRuntime(name);
      // A runtime pending deletion is gone for every purpose but its name;
      // reconcile restores it when it is ours.
      if (runtime === undefined || runtime.State === "PENDING_DELETION") return undefined;
      const attrs = toAttrs(runtime);
      return (yield* hasAlchemyTags(id, yield* observedTags(runtime.Arn))) ? attrs : Unowned(attrs);
    }),

    list: () =>
      lambdacore.listRuntimes.items({}).pipe(
        Stream.filter((runtime) => runtime.State !== "PENDING_DELETION"),
        Stream.mapEffect((summary) => getRuntime(summary.Arn), { concurrency: 5 }),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk).flatMap((r) => (r ? [toAttrs(r)] : []))),
      ),

    reconcile: Effect.fn(function* ({ id, news, output, session }) {
      const name = output?.runtimeName ?? (yield* resolveRuntimeName(id, news.name));
      const internalTags = yield* createInternalTags(id);
      const desiredTags = { ...news.tags, ...internalTags };
      const desiredLifecycle = fromLifecycle(toLifecycle(news.releaseLifecycle));

      // Observe. A runtime of ours that is pending deletion keeps its name
      // reserved, so restore it rather than fail to recreate it.
      let runtime = yield* getRuntime(name);
      if (runtime?.State === "PENDING_DELETION") {
        if (!(yield* hasAlchemyTags(id, yield* observedTags(runtime.Arn)))) {
          return yield* new RuntimeNameReserved({
            message: `Runtime ${name} is pending deletion until ${runtime.PendingDeletionAt} and is not owned by this stack; its name is reserved until then.`,
          });
        }
        yield* session.note(`Restoring runtime ${name} from pending deletion...`);
        yield* lambdacore.restoreRuntime({ RuntimeName: name });
        runtime = yield* getRuntime(name);
      }

      // Ensure.
      if (runtime === undefined) {
        yield* session.note(`Creating runtime ${name}...`);
        yield* lambdacore
          .createRuntime({
            Name: name,
            Description: news.description,
            LicenseInfo: news.licenseInfo,
            ReleaseLifecycle: toLifecycle(news.releaseLifecycle),
            Tags: desiredTags,
          })
          .pipe(Effect.catchTag("ResourceConflictException", () => Effect.void));
        runtime = yield* getRuntime(name);
        if (runtime === undefined) {
          return yield* Effect.die(`Runtime ${name} was created but could not be read.`);
        }
      }

      // Sync description, license and lifecycle. UpdateRuntime replaces all
      // three, so send every one.
      if (
        (runtime.Description || undefined) !== news.description ||
        (runtime.LicenseInfo || undefined) !== news.licenseInfo ||
        !lifecycleEqual(fromLifecycle(runtime.ReleaseLifecycle), desiredLifecycle)
      ) {
        yield* session.note(`Updating runtime ${name}...`);
        yield* lambdacore.updateRuntime({
          RuntimeName: name,
          Description: news.description ?? "",
          LicenseInfo: news.licenseInfo ?? "",
          ReleaseLifecycle: toLifecycle(news.releaseLifecycle) ?? {},
        });
        runtime = (yield* getRuntime(name)) ?? runtime;
      }

      // Sync tags against the runtime's observed tags.
      const { removed, upsert } = diffTags(yield* observedTags(runtime.Arn), desiredTags);
      if (upsert.length > 0) {
        yield* Lambda.tagResource({
          Resource: runtime.Arn,
          Tags: Object.fromEntries(upsert.map((tag) => [tag.Key, tag.Value])),
        });
      }
      if (removed.length > 0) {
        yield* Lambda.untagResource({ Resource: runtime.Arn, TagKeys: removed });
      }

      yield* syncPolicy(runtime.Arn, news.sharing);

      return toAttrs(runtime);
    }),

    delete: Effect.fn(function* ({ olds, output, session, force }) {
      yield* session.note(`Scheduling runtime ${output.runtimeName} for deletion...`);
      // Deleting a runtime that is already pending deletion succeeds and
      // keeps its original window.
      yield* lambdacore
        .deleteRuntime({
          RuntimeName: output.runtimeName,
          RecoveryWindowInDays: recoveryWindowOf(olds.recoveryWindowInDays, force),
        })
        .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void));
    }),
  });
