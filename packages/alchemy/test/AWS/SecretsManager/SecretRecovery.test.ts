import { Credentials } from "@distilled.cloud/aws/Credentials";
import { describe, expect } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { apply } from "@/Apply";
import { provideFreshArtifactStore } from "@/Artifacts";
import * as Endpoint from "@/AWS/Endpoint.ts";
import * as Region from "@/AWS/Region.ts";
import { Secret, SecretProvider } from "@/AWS/SecretsManager/Secret.ts";
import * as Plan from "@/Plan";
import * as Stack from "@/Stack";
import { Stage } from "@/Stage";
import { InMemoryService, State } from "@/State";
import * as Test from "@/Test/Alchemy";

const { test } = Test.make({
  providers: Layer.empty,
  state: Layer.effect(
    State,
    Effect.sync(() => InMemoryService({})),
  ),
});

/**
 * `Secret.recoveryWindowInDays` is an opt-in `DeleteSecret` recovery window.
 *
 * The provider runs against an in-memory Secrets Manager that speaks the
 * AWS JSON wire protocol and models the behaviour that matters here: a
 * force-deleted secret disappears, a secret deleted with a recovery window
 * stays visible with `DeletedDate` set, and `CreateSecret` refuses a name
 * that is still scheduled for deletion.
 */

interface FakeSecret {
  arn: string;
  name: string;
  deletedDate: number | undefined;
  tags: Array<{ Key: string; Value: string }>;
}

const makeFakeSecretsManager = () => {
  const secrets = new Map<string, FakeSecret>();
  const calls: Array<{ operation: string; input: Record<string, any> }> = [];

  const find = (id: string) =>
    [...secrets.values()].find((secret) => secret.arn === id || secret.name === id);

  const fail = (request: any, type: string, message: string) =>
    HttpClientResponse.fromWeb(
      request,
      new Response(JSON.stringify({ __type: type, message }), {
        status: 400,
        headers: { "x-amzn-errortype": type, "content-type": "application/x-amz-json-1.1" },
      }),
    );

  const respond = (request: any, body: unknown) =>
    HttpClientResponse.fromWeb(
      request,
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/x-amz-json-1.1" },
      }),
    );

  const handle = (request: any, operation: string, input: Record<string, any>) => {
    switch (operation) {
      case "CreateSecret": {
        const existing = secrets.get(input.Name);
        if (existing?.deletedDate) {
          return fail(
            request,
            "InvalidRequestException",
            "You can't create this secret because a secret with this name is already scheduled for deletion.",
          );
        }
        if (existing) return fail(request, "ResourceExistsException", "exists");
        const created = {
          arn: `arn:aws:secretsmanager:us-east-1:123456789012:secret:${input.Name}-AbCdEf`,
          name: input.Name as string,
          deletedDate: undefined,
          tags: input.Tags ?? [],
        };
        secrets.set(created.name, created);
        return respond(request, { ARN: created.arn, Name: created.name, VersionId: "v1" });
      }
      case "DescribeSecret": {
        const secret = find(input.SecretId);
        if (!secret) return fail(request, "ResourceNotFoundException", "not found");
        return respond(request, {
          ARN: secret.arn,
          Name: secret.name,
          Tags: secret.tags,
          ...(secret.deletedDate ? { DeletedDate: secret.deletedDate } : {}),
        });
      }
      case "UpdateSecret": {
        const secret = find(input.SecretId);
        if (!secret) return fail(request, "ResourceNotFoundException", "not found");
        if (secret.deletedDate) {
          return fail(
            request,
            "InvalidRequestException",
            "You can't perform this operation on the secret because it was marked for deletion.",
          );
        }
        return respond(request, { ARN: secret.arn, Name: secret.name, VersionId: "v2" });
      }
      case "TagResource": {
        const secret = find(input.SecretId);
        if (!secret) return fail(request, "ResourceNotFoundException", "not found");
        secret.tags = [
          ...secret.tags.filter((tag) => !input.Tags.some((t: any) => t.Key === tag.Key)),
          ...input.Tags,
        ];
        return respond(request, {});
      }
      case "GetResourcePolicy":
        return respond(request, {});
      case "DeleteSecret": {
        const secret = find(input.SecretId);
        if (!secret) return fail(request, "ResourceNotFoundException", "not found");
        if (input.ForceDeleteWithoutRecovery) secrets.delete(secret.name);
        else secret.deletedDate = 1;
        return respond(request, { ARN: secret.arn, Name: secret.name });
      }
      case "RestoreSecret": {
        const secret = find(input.SecretId);
        if (!secret) return fail(request, "ResourceNotFoundException", "not found");
        secret.deletedDate = undefined;
        return respond(request, { ARN: secret.arn, Name: secret.name });
      }
      default:
        return fail(request, "InvalidRequestException", `unexpected ${operation}`);
    }
  };

  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const operation = String(request.headers["x-amz-target"]).split(".")[1];
      const body =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}";
      const input = JSON.parse(body) as Record<string, any>;
      calls.push({ operation, input });
      return handle(request, operation, input);
    }),
  );

  return { secrets, calls, client };
};

const STAGE = "test";

const makeHarness = () => {
  const fake = makeFakeSecretsManager();
  const store: Record<string, Record<string, Record<string, any>>> = {};
  const aws = Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, fake.client),
    Layer.succeed(
      Credentials,
      Effect.succeed({
        accessKeyId: Redacted.make("AKIDEXAMPLE"),
        secretAccessKey: Redacted.make("example"),
        sessionToken: undefined,
        region: "us-east-1",
      }),
    ),
    Region.of("us-east-1"),
    Endpoint.none,
  );
  const providers = SecretProvider();
  const deploy = (effect: Effect.Effect<any, any, any>) =>
    (effect as Effect.Effect<any, any, never>).pipe(
      Stack.make({
        name: "secret-recovery",
        providers: providers as Layer.Layer<any, never, any>,
        state: Layer.effect(
          State,
          Effect.sync(() => InMemoryService(store)),
        ),
      }),
      Effect.flatMap((compiled: any) =>
        Plan.make(compiled).pipe(Effect.flatMap(apply), Effect.provide(compiled.services)),
      ),
      // Provider methods run inside the engine, so the fake AWS services are
      // provided to the whole deploy rather than to the provider layer.
      Effect.provide(aws),
      Effect.provide(Layer.succeed(Stage, STAGE)),
      provideFreshArtifactStore,
    ) as unknown as Effect.Effect<any, any, never>;
  return { fake, deploy };
};

const secretProgram = (props: { recoveryWindowInDays?: number }) =>
  Effect.gen(function* () {
    return yield* Secret("Db", {
      name: "app/db",
      secretString: Redacted.make("value"),
      ...props,
    });
  });
const emptyProgram = Effect.succeed(undefined);

/** The `_tag`s of every failure and defect in a deploy's exit. */
const failureTags = (exit: Exit.Exit<unknown, unknown>): string[] =>
  Exit.isFailure(exit)
    ? exit.cause.reasons
        .map((reason) =>
          Cause.isFailReason(reason)
            ? reason.error
            : Cause.isDieReason(reason)
              ? reason.defect
              : undefined,
        )
        .map((value) =>
          typeof value === "object" && value !== null && "_tag" in value ? String(value._tag) : "",
        )
    : [];

describe("Secret recovery window", { tags: ["unit", "local"] }, () => {
  test(
    "force-deletes immediately when no recovery window is set",
    Effect.gen(function* () {
      const { fake, deploy } = makeHarness();
      yield* deploy(secretProgram({}));
      yield* deploy(emptyProgram);
      const deletion = fake.calls.find((call) => call.operation === "DeleteSecret");
      expect(deletion?.input.ForceDeleteWithoutRecovery).toBe(true);
      expect(deletion?.input.RecoveryWindowInDays).toBeUndefined();
      expect(fake.secrets.size).toBe(0);
    }),
  );

  test(
    "keeps the secret recoverable when a recovery window is set",
    Effect.gen(function* () {
      const { fake, deploy } = makeHarness();
      yield* deploy(secretProgram({ recoveryWindowInDays: 14 }));
      yield* deploy(emptyProgram);
      const deletion = fake.calls.find((call) => call.operation === "DeleteSecret");
      expect(deletion?.input.RecoveryWindowInDays).toBe(14);
      expect(deletion?.input.ForceDeleteWithoutRecovery).toBeUndefined();
      expect(fake.secrets.get("app/db")?.deletedDate).toBeDefined();
    }),
  );

  test(
    "restores a secret pending deletion when the same Secret is added back",
    Effect.gen(function* () {
      const { fake, deploy } = makeHarness();
      yield* deploy(secretProgram({ recoveryWindowInDays: 14 }));
      yield* deploy(emptyProgram);
      yield* deploy(secretProgram({ recoveryWindowInDays: 14 }));
      expect(fake.calls.some((call) => call.operation === "RestoreSecret")).toBe(true);
      expect(fake.secrets.get("app/db")?.deletedDate).toBeUndefined();
      expect(fake.calls.filter((call) => call.operation === "CreateSecret")).toHaveLength(1);
    }),
  );

  test(
    "refuses a recovery window outside 7 to 30 days",
    Effect.gen(function* () {
      for (const recoveryWindowInDays of [6, 31, 7.5]) {
        const { fake, deploy } = makeHarness();
        const exit = yield* Effect.exit(deploy(secretProgram({ recoveryWindowInDays })));
        expect(failureTags(exit)).toContain("SecretRecoveryWindowOutOfRange");
        expect(fake.calls.some((call) => call.operation === "CreateSecret")).toBe(false);
      }
      // Control: both ends of the range are accepted.
      for (const recoveryWindowInDays of [7, 30]) {
        const { fake, deploy } = makeHarness();
        yield* deploy(secretProgram({ recoveryWindowInDays }));
        expect(fake.secrets.get("app/db")?.deletedDate).toBeUndefined();
      }
    }),
  );

  test(
    "does not restore a pending secret that another owner created",
    Effect.gen(function* () {
      const { fake, deploy } = makeHarness();
      fake.secrets.set("app/db", {
        arn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:app/db-XyZaBc",
        name: "app/db",
        deletedDate: 1,
        tags: [
          { Key: "alchemy::stack", Value: "another-stack" },
          { Key: "alchemy::stage", Value: STAGE },
          { Key: "alchemy::id", Value: "Db" },
        ],
      });
      const exit = yield* Effect.exit(deploy(secretProgram({ recoveryWindowInDays: 14 })));
      expect(failureTags(exit)).toContain("OwnedBySomeoneElse");
      expect(fake.calls.some((call) => call.operation === "RestoreSecret")).toBe(false);
      expect(fake.secrets.get("app/db")?.deletedDate).toBe(1);
    }),
  );
});
