import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import type { Input } from "../../Input.ts";
import {
  hostAwsAccess,
  regionFromArn,
  withRuntimeCredentials,
  type WorkerAwsAccess,
} from "../Lambda/BindingHttp.ts";
import { CurrentRegion } from "../Region.ts";
import type { Table } from "./Table.ts";

/**
 * Shared scaffolding for AWS DynamoDB HTTP bindings.
 *
 * NOT exported from `index.ts` — every near-identical `{Op}Http.ts` in this
 * service is a thin `Layer.effect(Cap, make…HttpBinding({ … }))` over one of
 * the builders below. Everything except the operation, the IAM action list,
 * and the granted ARNs is boilerplate. Genuinely-different bindings
 * (multi-table batches/transactions, restores, the batched sink) stay
 * bespoke but share {@link grantTables} / {@link tablesRegion} /
 * {@link signed}.
 *
 * Every binding works on any AWS host (Lambda, ECS, Kubernetes) and on a
 * Cloudflare Worker:
 *
 * - on an AWS host the deploy-time grant goes on the host's execution role
 *   and requests use the ambient `Credentials` / `Region`;
 * - on a Worker host the grant goes on the least-privilege role the Worker
 *   assumes (see `workerAwsAccess`), and each request is signed with the
 *   assumed role in the bound table's region (parsed from its ARN).
 */

/**
 * Stand-in region for AWS hosts, whose `Region` is ambient: the runtime
 * helpers only read the region on a Worker host.
 */
const ambientRegion: Effect.Effect<string> = Effect.die(
  new Error("DynamoDB binding: the host's AWS Region is ambient"),
);

/**
 * Resolve how the host reaches AWS and grant it `policyStatements` under
 * `label` (see `hostAwsAccess`). The grant is deploy-only.
 */
export const grantTables = (
  label: string,
  policyStatements: () => Input<PolicyStatement>[],
) =>
  Effect.gen(function* () {
    const host = yield* Binding.Host;
    return yield* hostAwsAccess(host, () => ({
      label: `Allow(${host?.LogicalId}, ${label})`,
      policyStatements: policyStatements(),
    }));
  });

/**
 * The region a Worker host signs requests in: the region of the bound
 * tables, parsed from their ARNs (which this binds onto the Worker). Tables
 * bound together must share one region. On an AWS host the `Region` is
 * ambient and nothing is bound.
 *
 * The ARN is used rather than `Table.region` because tables whose state
 * predates that attribute keep their old attributes until their next update.
 */
export const tablesRegion = Effect.fn(function* (
  access: WorkerAwsAccess | undefined,
  tables: readonly Table[],
) {
  if (access === undefined) {
    return ambientRegion;
  }
  const arns = yield* Effect.forEach(tables, (table) =>
    Effect.gen(function* () {
      return yield* table.tableArn;
    }),
  );
  return Effect.gen(function* () {
    const regions = [...new Set((yield* Effect.all(arns)).map(regionFromArn))];
    if (regions.length !== 1) {
      return yield* Effect.die(
        new Error(
          `DynamoDB tables bound together must share one AWS region, got: ${regions.join(", ")}`,
        ),
      );
    }
    return regions[0]!;
  });
});

/**
 * The region a Worker host signs account-level requests (`ListTables`) in:
 * the stack's AWS region at deploy, bound onto the Worker. On an AWS host
 * the `Region` is ambient and nothing is bound.
 */
export const accountRegion = Effect.fn(function* (
  access: WorkerAwsAccess | undefined,
) {
  if (access === undefined) {
    return ambientRegion;
  }
  return yield* (
    Output.fromEffect(CurrentRegion.pipe(Effect.orDie)) as Output.Output<string>
  ).bind("ALCHEMY_AWS_REGION") as Effect.Effect<Effect.Effect<string>>;
});

/**
 * Run a distilled operation with host-appropriate credentials (see
 * `withRuntimeCredentials`). Its requirements are ambient on an AWS host
 * and provided around the call on a Worker host.
 */
export const signed = <A, E, R>(
  access: WorkerAwsAccess | undefined,
  region: Effect.Effect<string>,
  operation: Effect.Effect<A, E, R>,
): Effect.Effect<A, E> =>
  withRuntimeCredentials(access, region, operation) as Effect.Effect<A, E>;

/**
 * Build the impl Effect for an account-level operation (`ListTables`,
 * `DescribeLimits`): the runtime callable passes the caller's request
 * through unchanged and the deploy-time half grants `actions` on `*`
 * (these DynamoDB actions do not support resource-level permissions).
 */
export const makeAccountHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.DynamoDB.ListTables`. */
  tag: string;
  /**
   * The distilled operation, invoked per request with the caller's request
   * as-is. Its requirements (`Credentials`, `Region`, `HttpClient`) are
   * ambient on an AWS host and provided around each call on a Worker host.
   */
  operation: (input: I) => Effect.Effect<A, E, R>;
  /** IAM actions granted on `*`. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    return Effect.fn(function* () {
      const access = yield* grantTables(`${options.tag}()`, () => [
        {
          Effect: "Allow",
          Action: [...options.actions],
          Resource: ["*"],
        },
      ]);
      const region = yield* accountRegion(access);
      return Effect.fn(options.tag)(function* (request?: I) {
        return yield* signed(
          access,
          region,
          options.operation((request ?? {}) as I),
        );
      });
    });
  });

/**
 * Build the impl Effect for a table-scoped operation: the runtime callable
 * injects the bound {@link Table}'s physical name as `TableName` and the
 * deploy-time half grants `actions` on `resources` (default: the table ARN).
 */
export const makeTableHttpBinding = <
  I extends { TableName?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.DynamoDB.GetItem`. */
  tag: string;
  /**
   * The distilled operation, called per request; `TableName` is injected
   * from the table. Its requirements (`Credentials`, `Region`,
   * `HttpClient`) are ambient on an AWS host and provided around each call
   * on a Worker host.
   */
  operation: (input: I) => Effect.Effect<A, E, R>;
  /** IAM actions granted on `resources`. */
  actions: readonly string[];
  /** ARNs the actions are granted on. @default the table ARN */
  resources?: (table: Table) => (string | Output.Output<string>)[];
}) =>
  Effect.gen(function* () {
    return Effect.fn(function* (table: Table) {
      const TableName = yield* table.tableName;
      const access = yield* grantTables(
        `${options.tag}(${table.LogicalId})`,
        () => [
          {
            Effect: "Allow",
            Action: [...options.actions],
            Resource: options.resources?.(table) ?? [table.tableArn],
          },
        ],
      );
      const region = yield* tablesRegion(access, [table]);
      return Effect.fn(`${options.tag}(${table.LogicalId})`)(function* (
        request?: Omit<I, "TableName">,
      ) {
        return yield* signed(
          access,
          region,
          options.operation({
            ...request,
            TableName: yield* TableName,
          } as I),
        );
      });
    });
  });

/**
 * Build the impl Effect for an ARN-scoped operation: the runtime callable
 * injects the bound {@link Table}'s ARN under `key` (`ResourceArn` for the
 * tagging APIs, `TableArn` for the export APIs) and the deploy-time half
 * grants `actions` on `resources` (default: the table ARN).
 */
export const makeTableArnHttpBinding = <
  K extends "ResourceArn" | "TableArn",
  I extends { [P in K]?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.DynamoDB.ListTagsOfResource`. */
  tag: string;
  /** The request field the table ARN is injected under. */
  key: K;
  /**
   * The distilled operation, called per request; the table ARN is injected
   * under `key`. Its requirements are ambient on an AWS host and provided
   * around each call on a Worker host.
   */
  operation: (input: I) => Effect.Effect<A, E, R>;
  /** IAM actions granted on `resources`. */
  actions: readonly string[];
  /** ARNs the actions are granted on. @default the table ARN */
  resources?: (table: Table) => (string | Output.Output<string>)[];
}) =>
  Effect.gen(function* () {
    return Effect.fn(function* (table: Table) {
      const TableArn = yield* table.tableArn;
      const access = yield* grantTables(
        `${options.tag}(${table.LogicalId})`,
        () => [
          {
            Effect: "Allow",
            Action: [...options.actions],
            Resource: options.resources?.(table) ?? [table.tableArn],
          },
        ],
      );
      const region = access ? Effect.map(TableArn, regionFromArn) : undefined;
      return Effect.fn(`${options.tag}(${table.LogicalId})`)(function* (
        request?: Omit<I, K>,
      ) {
        return yield* signed(
          access,
          region ?? ambientRegion,
          options.operation({
            ...request,
            [options.key]: yield* TableArn,
          } as I),
        );
      });
    });
  });

/**
 * Build the impl Effect for an operation whose request carries its own
 * identifiers (a PartiQL statement, a backup or export ARN): the bound
 * {@link Table} only scopes the deploy-time IAM grant (and, on a Worker
 * host, the signing region); the request passes through unchanged.
 */
export const makeTableIamHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.DynamoDB.ExecuteStatement`. */
  tag: string;
  /**
   * The distilled operation, invoked per request with the caller's request
   * as-is. Its requirements are ambient on an AWS host and provided around
   * each call on a Worker host.
   */
  operation: (input: I) => Effect.Effect<A, E, R>;
  /** IAM actions granted on `resources`. */
  actions: readonly string[];
  /** ARNs the actions are granted on. */
  resources: (table: Table) => (string | Output.Output<string>)[];
}) =>
  Effect.gen(function* () {
    return Effect.fn(function* (table: Table) {
      const access = yield* grantTables(
        `${options.tag}(${table.LogicalId})`,
        () => [
          {
            Effect: "Allow",
            Action: [...options.actions],
            Resource: options.resources(table),
          },
        ],
      );
      const region = yield* tablesRegion(access, [table]);
      return Effect.fn(`${options.tag}(${table.LogicalId})`)(function* (
        request: I,
      ) {
        return yield* signed(access, region, options.operation(request));
      });
    });
  });
