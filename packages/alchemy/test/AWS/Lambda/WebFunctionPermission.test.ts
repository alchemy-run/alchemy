import { fileURLToPath } from "node:url";
import * as LambdaWeb from "@distilled.cloud/aws/lambda-web";
import * as sts from "@distilled.cloud/aws/sts";
import { expect } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";

const asyncServerMain = fileURLToPath(new URL("./fixtures/web/async-server.ts", import.meta.url));

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:lambda", "live"];

interface Statement {
  Sid: string;
  Principal: { AWS?: string; Service?: string };
  Resource: string;
}

const statementsOf = (functionArn: string) =>
  LambdaWeb.getResourcePolicy({ resourceArn: functionArn }).pipe(
    Effect.map((r) => (JSON.parse(r.policy) as { Statement: Statement[] }).Statement),
    Effect.catchTag("ResourceNotFoundException", () => Effect.succeed([] as Statement[])),
  );

test.provider(
  "grants coexist in one policy; removing one keeps the other",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { Account: accountId } = yield* sts.getCallerIdentity({});

      const deploy = (grants: ("Partner" | "Auditor")[]) =>
        stack.deploy(
          Effect.gen(function* () {
            const api = yield* AWS.Lambda.WebFunction("Granted", {
              main: asyncServerMain,
              authType: "IamAuth",
            });
            const permissions: Partial<
              Record<"Partner" | "Auditor", AWS.Lambda.WebFunctionPermission>
            > = {};
            for (const grant of grants) {
              permissions[grant] = yield* AWS.Lambda.WebFunctionPermission(grant, {
                endpoint: api,
                principal: accountId!,
              });
            }
            return { api, permissions };
          }),
        );

      const { api, permissions } = yield* deploy(["Partner", "Auditor"]);
      const statementIds = {
        Partner: permissions.Partner!.statementId,
        Auditor: permissions.Auditor!.statementId,
      };
      const both = yield* statementsOf(api.functionArn);
      expect(both.map((s) => s.Sid).sort()).toEqual(
        [statementIds.Partner!, statementIds.Auditor!].sort(),
      );
      for (const statement of both) {
        expect(statement.Resource).toBe(api.endpointArn);
        expect(statement.Principal.AWS).toContain(accountId!);
      }

      yield* deploy(["Auditor"]);
      const remaining = yield* statementsOf(api.functionArn);
      expect(remaining.map((s) => s.Sid)).toEqual([statementIds.Auditor!]);

      yield* deploy([]);
      expect(yield* statementsOf(api.functionArn)).toEqual([]);

      yield* stack.destroy();
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  { tags, timeout: 240_000 },
);

test.provider(
  "refuses to grant invoke on a public endpoint",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { Account: accountId } = yield* sts.getCallerIdentity({});
      const failure = yield* stack
        .deploy(
          Effect.gen(function* () {
            const api = yield* AWS.Lambda.WebFunction("Public", {
              main: asyncServerMain,
              authType: "ApplicationManaged",
            });
            return yield* AWS.Lambda.WebFunctionPermission("Grant", {
              endpoint: api,
              principal: accountId!,
            });
          }),
        )
        .pipe(Effect.exit);
      expect(failure._tag).toBe("Failure");
      if (failure._tag === "Failure") {
        expect(String(Cause.squash(failure.cause))).toContain("public");
      }
      yield* stack.destroy();
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  { tags, timeout: 180_000 },
);
