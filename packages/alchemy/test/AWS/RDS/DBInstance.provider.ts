import {
  DBInstance,
  DBInstanceProvider,
  type DBInstanceProps,
} from "@/AWS/RDS/DBInstance.ts";
import { InstanceId } from "@/InstanceId.ts";
import * as Provider from "@/Provider.ts";
import { Stack, type StackSpec } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import { fromCredentials } from "@distilled.cloud/aws/Credentials";
import { Region } from "@distilled.cloud/aws/Region";
import type * as rds from "@distilled.cloud/aws/rds";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

export const instanceId = "0123456789abcdef0123456789abcdef";
export const props: DBInstanceProps = {
  dbInstanceIdentifier: "alchemy-rds-instance",
  dbInstanceClass: "db.t3.micro",
  engine: "postgres",
};

const stack: Omit<StackSpec, "output"> = {
  name: "rds-provider",
  stage: "test",
  resources: {},
  bindings: {},
  actions: {},
};

export const instance = (fields: rds.DBInstance = {}): rds.DBInstance => ({
  DBInstanceIdentifier: props.dbInstanceIdentifier,
  DBInstanceArn: "arn:aws:rds:us-east-1:123456789012:db:alchemy-rds-instance",
  DBInstanceStatus: "available",
  DBInstanceClass: props.dbInstanceClass,
  Engine: props.engine,
  TagList: [
    { Key: "alchemy::stack", Value: stack.name },
    { Key: "alchemy::stage", Value: stack.stage },
    { Key: "alchemy::id", Value: "Db" },
  ],
  ...fields,
});

const memberNames: Record<string, string> = {
  DBParameterGroups: "DBParameterGroup",
  VpcSecurityGroups: "VpcSecurityGroupMembership",
  TagList: "Tag",
};

const xml = (value: unknown): string => {
  if (value === undefined) return "";
  if (typeof value === "object" && value !== null) {
    return Object.entries(value)
      .filter(([, field]) => field !== undefined)
      .map(([name, field]) => {
        const contents = Array.isArray(field)
          ? field
              .map(
                (item) =>
                  `<${memberNames[name] ?? "member"}>${xml(item)}</${memberNames[name] ?? "member"}>`,
              )
              .join("")
          : xml(field);
        return `<${name}>${contents}</${name}>`;
      })
      .join("");
  }
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
};

export const response = (action: string, result: string) =>
  new Response(
    `<${action}Response xmlns="http://rds.amazonaws.com/doc/2014-10-31/"><${action}Result>${result}</${action}Result></${action}Response>`,
    {
      headers: { "content-type": "text/xml" },
    },
  );

export const describeInstance = (value: rds.DBInstance | undefined) =>
  response(
    "DescribeDBInstances",
    `<DBInstances>${value === undefined ? "" : `<DBInstance>${xml(value)}</DBInstance>`}</DBInstances>`,
  );

export const errorResponse = (code: string, status = 400) =>
  new Response(
    `<ErrorResponse xmlns="http://rds.amazonaws.com/doc/2014-10-31/"><Error><Type>Sender</Type><Code>${code}</Code><Message>${code}</Message></Error><RequestId>request-id</RequestId></ErrorResponse>`,
    {
      status,
      headers: { "content-type": "text/xml" },
    },
  );

export interface Request {
  action: string;
  parameters: URLSearchParams;
  body: string;
}

/** Run the real provider and distilled request/response codecs without cloud IO. */
export const withInstance = <A, E, R>(
  respond: (request: Request) => Response,
  use: (
    provider: Provider.ProviderService<DBInstance>,
    requests: Request[],
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const requests: Request[] = [];
    const clock = yield* Clock.Clock;
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        if (request.body._tag !== "Uint8Array") {
          throw new Error(`Unexpected request body: ${request.body._tag}`);
        }
        const body = new TextDecoder().decode(request.body.body);
        const parameters = new URLSearchParams(body);
        const action =
          parameters.get("Action") ??
          request.headers["x-amz-target"]?.split(".").at(-1) ??
          "";
        const recorded = { action, parameters, body };
        requests.push(recorded);
        return HttpClientResponse.fromWeb(request, respond(recorded));
      }),
    );
    return yield* Effect.gen(function* () {
      const provider = yield* Provider.Provider<DBInstance>(DBInstance.Type);
      return yield* use(provider, requests);
    }).pipe(
      Effect.provide(DBInstanceProvider()),
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, http),
          // Advance virtual time when the provider requests a retry delay.
          // AWS signing and response parsing use promises, so advancing the
          // clock before those settle would race the timer's registration.
          Layer.succeed(Clock.Clock, { ...clock, sleep: TestClock.adjust }),
          fromCredentials(
            {
              accessKeyId: "AKIAIOSFODNN7EXAMPLE",
              secretAccessKey: "test-secret-key",
            },
            "us-east-1",
          ),
          Layer.succeed(Region, Effect.succeed("us-east-1")),
          Layer.succeed(Stack, stack),
          Layer.succeed(Stage, stack.stage),
          Layer.succeed(InstanceId, instanceId),
        ),
      ),
    );
  });

export const reconcile = (
  provider: Provider.ProviderService<DBInstance>,
  news: DBInstanceProps,
) =>
  provider.reconcile({
    id: "Db",
    fqn: "Db",
    instanceId,
    news,
    olds: undefined,
    output: undefined,
    bindings: [],
    session: {
      emit: () => Effect.void,
      done: () => Effect.void,
      note: () => Effect.void,
    },
  });
