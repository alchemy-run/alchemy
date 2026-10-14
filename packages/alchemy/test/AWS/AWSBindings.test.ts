import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as AWS from "@/AWS";
import { AWSEnvironment } from "@/AWS/Environment.ts";
import { isResolved } from "@/Diff.ts";
import * as Plan from "@/Plan";
import { Platform, type Main, type PlatformProps } from "@/Platform.ts";
import * as Provider from "@/Provider.ts";
import type { Resource } from "@/Resource.ts";
import {
  createHostRuntimeContext,
  type HostRuntimeContext,
  type ServerHost,
} from "@/Server/Process.ts";
import * as Stack from "@/Stack";
import { Stage } from "@/Stage";
import { inMemoryState, State } from "@/State";
import * as Test from "@/Test/Alchemy";

// A host outside AWS (think Cloudflare Worker, Cloud Run): AWS bindings on it
// mint an IAM user + access key + role and grant on that role.
interface ExternalHost extends Resource<
  "Test.ExternalHost",
  PlatformProps & { main?: string },
  { ok: true }
> {}

const ExternalHost: Platform<
  ExternalHost,
  ServerHost,
  Main<ServerHost>,
  HostRuntimeContext
> = Platform("Test.ExternalHost", {
  createRuntimeContext: createHostRuntimeContext("Test.ExternalHost"),
});

const noopProvider = (resource: any) =>
  Provider.succeed(resource, {
    list: () => Effect.succeed([]),
    diff: Effect.fn(function* ({ news }) {
      if (!isResolved(news)) return undefined;
    }),
    reconcile: Effect.fn(function* ({ output }) {
      return output ?? ({ ok: true } as any);
    }),
    delete: Effect.fn(function* () {}),
  });

const providers = () =>
  Layer.mergeAll(
    noopProvider(ExternalHost),
    noopProvider(AWS.IAM.User),
    noopProvider(AWS.IAM.AccessKey),
    noopProvider(AWS.IAM.Role),
    noopProvider(AWS.SQS.Queue),
    noopProvider(AWS.S3.Bucket),
    noopProvider(AWS.DynamoDB.Table),
  );

const { test } = Test.make({ providers: providers(), state: inMemoryState() });

const makePlan = <A, Err, Req>(
  effect: Effect.Effect<A, Err, Req>,
): Effect.Effect<Plan.Plan<A>, Err, State> =>
  effect.pipe(
    // @ts-expect-error - Stack.make's typing erases R unsoundly here
    Stack.make({ name: "host-access-plan", providers: providers(), state: inMemoryState() }),
    Effect.provideService(Stage, "test"),
    // The stack's AWS account and region, as the AWS providers supply them.
    Effect.provideService(
      AWSEnvironment,
      Effect.succeed({ accountId: "123456789012", region: "us-east-1" } as never),
    ),
    Effect.flatMap((compiled: any) => Plan.make(compiled).pipe(Effect.provide(compiled.services))),
  );

test(
  "an AWS binding on an external host grants on a minted role",
  Effect.gen(function* () {
    const plan = yield* ExternalHost(
      "Api",
      { main: "index.ts" },
      Effect.gen(function* () {
        yield* AWS.AccessAnalyzer.ValidatePolicy();
        return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
      }).pipe(Effect.provide(AWS.AccessAnalyzer.ValidatePolicyHttp)),
    ).pipe(makePlan, Effect.timeout(30_000));

    // The host's identity: one user, its key, and the role it assumes.
    expect(Object.keys(plan.resources)).toEqual(
      expect.arrayContaining(["Api", "ApiUser", "ApiAccessKey", "ApiRole"]),
    );
    // The grant lands on the role, under the same label a native host gets.
    expect(plan.resources["ApiRole"]?.bindings).toEqual([
      expect.objectContaining({
        sid: "Allow(Api, AWS.AccessAnalyzer.ValidatePolicy())",
        data: {
          policyStatements: [
            { Effect: "Allow", Action: ["access-analyzer:ValidatePolicy"], Resource: ["*"] },
          ],
        },
      }),
    ]);
    expect(plan.resources["Api"]?.bindings ?? []).toEqual([]);
    // The key, role ARN and signing region reach the host through its env,
    // registered when the binding's layer resolves its operation.
    const env = Object.keys(
      (plan.resources["Api"] as { props?: { env?: object } } | undefined)?.props?.env ?? {},
    );
    expect(env).toEqual(
      expect.arrayContaining([
        "ApiAccessKey_accessKeyId",
        "ApiAccessKey_secretAccessKey",
        "ApiRole_roleArn",
        "ALCHEMY_AWS_REGION",
      ]),
    );
  }),
  { tags: ["unit", "provider:aws", "local"], timeout: 60_000 },
);

test(
  "a resource-scoped binding grants on the external host's role",
  Effect.gen(function* () {
    const plan = yield* ExternalHost(
      "Producer",
      { main: "index.ts" },
      Effect.gen(function* () {
        const queue = yield* AWS.SQS.Queue("Jobs");
        yield* AWS.SQS.SendMessage(queue);
        return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
      }).pipe(Effect.provide(AWS.SQS.SendMessageHttp)),
    ).pipe(makePlan, Effect.timeout(30_000));

    expect(plan.resources["ProducerRole"]?.bindings).toEqual([
      expect.objectContaining({
        sid: "Allow(Producer, AWS.SQS.SendMessage(Jobs))",
        data: {
          policyStatements: [
            expect.objectContaining({ Effect: "Allow", Action: ["sqs:SendMessage"] }),
          ],
        },
      }),
    ]);
    expect(plan.resources["Producer"]?.bindings ?? []).toEqual([]);
  }),
  { tags: ["unit", "provider:aws", "local"], timeout: 60_000 },
);

test(
  "bindings signing in their resource's region grant on the external host's role",
  Effect.gen(function* () {
    const plan = yield* ExternalHost(
      "Reader",
      { main: "index.ts" },
      Effect.gen(function* () {
        const bucket = yield* AWS.S3.Bucket("Assets");
        const table = yield* AWS.DynamoDB.Table("Items", {
          partitionKey: "pk",
          attributes: { pk: "S" },
        });
        yield* AWS.S3.GetObject(bucket);
        yield* AWS.DynamoDB.GetItem(table);
        return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
      }).pipe(Effect.provide(Layer.mergeAll(AWS.S3.GetObjectHttp, AWS.DynamoDB.GetItemHttp))),
    ).pipe(makePlan, Effect.timeout(30_000));

    expect(plan.resources["ReaderRole"]?.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sid: "Allow(Reader, AWS.S3.GetObject(Assets))" }),
        expect.objectContaining({ sid: "Allow(Reader, AWS.DynamoDB.GetItem(Items))" }),
      ]),
    );
    expect(plan.resources["Reader"]?.bindings ?? []).toEqual([]);
  }),
  { tags: ["unit", "provider:aws", "local"], timeout: 60_000 },
);
