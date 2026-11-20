import type { PolicyStatement } from "@alchemy.run/aws/IAM/Policy";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  compactFunctionPolicy,
  functionLogGroupGuard,
  functionPolicyStatements,
  LambdaRolePolicyMaxBytes,
  renderFunctionPolicy,
} from "../../../../aws/src/Lambda/internal/FunctionPolicy.ts";

const guard = functionLogGroupGuard("us-east-1", "100000002303", "policy-unit-test");

const grant = (
  Action: string[],
  Resource: string[],
  extra: Partial<PolicyStatement> = {},
): PolicyStatement => ({ Effect: "Allow", Action, Resource, ...extra });

const list = (value: string | readonly string[] | undefined): string[] =>
  value === undefined ? [] : typeof value === "string" ? [value] : [...value];

/**
 * Every granted `[effect, action, resource, condition]` tuple, order-insensitive.
 * Compaction may regroup tuples; it may not invent one.
 */
const permissionPairs = (statements: readonly PolicyStatement[]) =>
  [
    ...new Set(
      statements.flatMap((statement) =>
        list(statement.Action).flatMap((action) =>
          list(statement.Resource).map((resource) =>
            JSON.stringify([statement.Effect, action, resource, statement.Condition ?? null]),
          ),
        ),
      ),
    ),
  ].sort();

describe("compaction", { tags: ["unit", "local"] }, () => {
  it("removes exact duplicates and normalizes action and resource sets", () => {
    const statement = grant(["s3:GetObject", "s3:ListBucket"], ["bucket", "object"]);
    expect(
      compactFunctionPolicy([
        statement,
        statement,
        grant(["s3:ListBucket", "s3:GetObject", "s3:GetObject"], ["object", "bucket"]),
      ]),
    ).toEqual([grant(["s3:GetObject", "s3:ListBucket"], ["bucket", "object"])]);
  });

  it("unions resources for equal actions, then actions for equal resources", () => {
    expect(
      compactFunctionPolicy([
        grant(["read"], ["a"]),
        grant(["read"], ["b"]),
        grant(["write"], ["b", "a"]),
      ]),
    ).toEqual([grant(["read", "write"], ["a", "b"])]);
  });

  it("preserves every pair without widening into a Cartesian product", () => {
    const original = [
      grant(["read"], ["a"]),
      grant(["write"], ["b"]),
      grant(["read"], ["c"]),
      grant(["delete"], ["c"]),
    ];
    const compacted = compactFunctionPolicy(original);
    expect(permissionPairs(compacted)).toEqual(permissionPairs(original));
    // The merged statement must not claim read on b/c or write on a/c.
    expect(permissionPairs(compacted)).not.toContain(JSON.stringify(["Allow", "read", "b", null]));
  });

  it("preserves every pair over every non-empty three-by-three grant matrix", () => {
    for (let mask = 1; mask < 512; mask++) {
      const original: PolicyStatement[] = [];
      for (let cell = 0; cell < 9; cell++) {
        if (mask & (1 << cell)) {
          original.push(grant([`action-${Math.floor(cell / 3)}`], [`resource-${cell % 3}`]));
        }
      }
      expect(permissionPairs(compactFunctionPolicy(original))).toEqual(permissionPairs(original));
    }
  });

  it("never merges across principals, conditions, or negative selectors", () => {
    const original: PolicyStatement[] = [
      grant(["read"], ["a"], { Principal: "one" }),
      grant(["read"], ["b"], { Principal: "two" }),
      grant(["read"], ["a"], { Condition: { StringEquals: { "aws:PrincipalOrgID": "one" } } }),
      grant(["read"], ["a"], { Condition: { StringEquals: { "aws:PrincipalOrgID": "two" } } }),
      grant(["read"], ["a"], { Effect: "Deny" }),
      grant(["read"], ["a"], { NotAction: ["delete"] }),
      grant(["read"], ["a"], { NotResource: ["hidden"] }),
      { Effect: "Allow", Action: ["read"] },
      { Effect: "Allow", Resource: ["a"] },
    ];
    const compacted = compactFunctionPolicy(original);
    expect(compacted).toHaveLength(original.length);
    expect(permissionPairs(compacted)).toEqual(permissionPairs(original));
  });

  it("orders canonically regardless of registration or object-key order", () => {
    const statements = [
      grant(["write"], ["b"], {
        Sid: "Second-Sid",
        Condition: { StringEquals: { z: "z", a: "a" } },
      }),
      grant(["read"], ["a"]),
      grant(["write"], ["a"], {
        Sid: "FirstSid",
        Condition: { StringEquals: { a: "a", z: "z" } },
      }),
    ];
    const before = JSON.stringify(statements);
    expect(JSON.stringify(compactFunctionPolicy(statements))).toBe(
      JSON.stringify(compactFunctionPolicy([...statements].reverse())),
    );
    expect(JSON.stringify(statements)).toBe(before);
  });
});

describe("aggregate inline-policy budget", { tags: ["unit", "local"] }, () => {
  it.effect("includes destination permissions alongside active binding grants", () =>
    Effect.gen(function* () {
      const queue = "arn:aws:sqs:us-east-1:100000002303:destination";
      const bucket = "arn:aws:s3:::destination";
      const statements = functionPolicyStatements(
        [
          { sid: "active", data: { policyStatements: [grant(["s3:GetObject"], ["object"])] } },
          {
            sid: "removed",
            action: "delete",
            data: { policyStatements: [grant(["read"], ["gone"])] },
          },
        ],
        [queue, bucket],
      );
      const { document } = yield* renderFunctionPolicy("destinations", statements, guard);
      expect(permissionPairs(JSON.parse(document!).Statement)).toEqual(
        permissionPairs([
          grant(["s3:GetObject"], ["object"]),
          grant(["sqs:SendMessage"], [queue]),
          grant(["s3:ListBucket"], [bucket]),
          grant(["s3:PutObject"], [`${bucket}/*`]),
        ]),
      );
      const oversized = functionPolicyStatements(
        [],
        [`${queue}${"x".repeat(LambdaRolePolicyMaxBytes)}`],
      );
      const result = yield* Effect.result(renderFunctionPolicy("destinations", oversized, guard));
      expect(Result.isFailure(result)).toBe(true);
    }),
  );

  it.effect("accepts exactly the byte budget and rejects one byte more", () =>
    Effect.gen(function* () {
      const overhead = (yield* renderFunctionPolicy("boundary", [grant(["read"], [""])], guard))
        .sizeBytes;
      const resource = "x".repeat(LambdaRolePolicyMaxBytes - overhead);
      const atLimit = yield* renderFunctionPolicy("boundary", [grant(["read"], [resource])], guard);
      expect(atLimit.sizeBytes).toBe(LambdaRolePolicyMaxBytes);
      const over = yield* Effect.result(
        renderFunctionPolicy("boundary", [grant(["read"], [`${resource}x`])], guard),
      );
      expect(Result.isFailure(over)).toBe(true);
    }),
  );

  it.effect("counts the log-group guard against the same budget and names the role", () =>
    Effect.gen(function* () {
      const guardOnly = (yield* renderFunctionPolicy("guard-only", [], guard)).sizeBytes;
      expect(guardOnly).toBeGreaterThan(0);
      // Sized so the binding document alone still fits the per-policy quota,
      // while the role's aggregate inline policy does not.
      const resource = "x".repeat(LambdaRolePolicyMaxBytes - guardOnly + 1);
      const result = yield* Effect.result(
        renderFunctionPolicy("example-Api-too-large", [grant(["read"], [resource])], guard),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.roleName).toBe("example-Api-too-large");
        expect(result.failure.sizeBytes).toBeGreaterThan(LambdaRolePolicyMaxBytes);
        expect(result.failure.limitBytes).toBe(LambdaRolePolicyMaxBytes);
        expect(result.failure.message).toContain(String(result.failure.sizeBytes));
        expect(result.failure.message).toContain("example-Api-too-large");
      }
    }),
  );

  it.effect("compacts a realistic binding set that would not fit unmerged, preserving pairs", () =>
    Effect.gen(function* () {
      const statements: PolicyStatement[] = Array.from({ length: 37 }, (_, i) => ({
        Effect: "Allow",
        Action:
          i % 4 === 0
            ? ["s3:GetObject", "s3:GetObjectVersion", "s3:ListBucket"]
            : i % 4 === 1
              ? ["s3:DeleteObject"]
              : i % 4 === 2
                ? ["sqs:SendMessage"]
                : ["iam:PassRole"],
        Resource: [
          `arn:aws:${i % 4 === 2 ? "sqs" : i % 4 === 3 ? "iam" : "s3"}:us-east-1:100000002303:example-api-artifacts-and-deliveries-local-e2e-4b98fb8c-af57859219-${i.toString().padStart(2, "0")}`,
        ],
        Condition: { StringEquals: { "aws:ResourceAccount": "100000002303" } },
      }));
      const repeated = [...statements, ...statements.slice(0, 8)];
      const uncompacted = new TextEncoder().encode(
        JSON.stringify({ Version: "2012-10-17", Statement: repeated }),
      ).byteLength;
      const rendered = yield* renderFunctionPolicy("example-Api-test", repeated, guard);
      expect(uncompacted).toBeGreaterThan(LambdaRolePolicyMaxBytes);
      expect(rendered.sizeBytes).toBeLessThanOrEqual(LambdaRolePolicyMaxBytes);
      expect(permissionPairs(JSON.parse(rendered.document!).Statement)).toEqual(
        permissionPairs(repeated),
      );
    }),
  );
});
