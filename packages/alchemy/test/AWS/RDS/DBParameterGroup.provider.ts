import {
  DBParameterGroup,
  DBParameterGroupProvider,
  type DBParameterGroupProps,
} from "@/AWS/RDS/DBParameterGroup.ts";
import { InstanceId } from "@/InstanceId.ts";
import * as Provider from "@/Provider.ts";
import { Stack } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import { fromCredentials } from "@distilled.cloud/aws/Credentials";
import { Region } from "@distilled.cloud/aws/Region";
import type { Parameter } from "@distilled.cloud/aws/rds";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

export const props: DBParameterGroupProps = {
  dbParameterGroupName: "alchemy-parameters",
  family: "postgres16",
};
export const output: DBParameterGroup["Attributes"] = {
  dbParameterGroupName: "alchemy-parameters",
  dbParameterGroupArn:
    "arn:aws:rds:us-east-1:123456789012:pg:alchemy-parameters",
  family: "postgres16",
  description: "Managed parameters",
  parameters: {},
  tags: {
    "alchemy::stack": "parameter-group",
    "alchemy::stage": "test",
    "alchemy::id": "Parameters",
  },
};
export const context = {
  id: "Parameters",
  fqn: "Parameters",
  instanceId: "0123456789abcdef0123456789abcdef",
};
export const response = (action: string, result = "") =>
  new Response(
    `<${action}Response xmlns="http://rds.amazonaws.com/doc/2014-10-31/"><${action}Result>${result}</${action}Result></${action}Response>`,
    { headers: { "content-type": "text/xml" } },
  );
export const groupResponse = () =>
  response(
    "DescribeDBParameterGroups",
    `<DBParameterGroups><DBParameterGroup><DBParameterGroupName>${output.dbParameterGroupName}</DBParameterGroupName><DBParameterGroupArn>${output.dbParameterGroupArn}</DBParameterGroupArn><DBParameterGroupFamily>${output.family}</DBParameterGroupFamily><Description>${output.description}</Description></DBParameterGroup></DBParameterGroups>`,
  );
const escape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
export const parametersResponse = (parameters: Parameter[], marker?: string) =>
  response(
    "DescribeDBParameters",
    `<Parameters>${parameters
      .map(
        (parameter) =>
          `<Parameter>${Object.entries(parameter)
            .map(([key, value]) => `<${key}>${escape(String(value))}</${key}>`)
            .join("")}</Parameter>`,
      )
      .join(
        "",
      )}</Parameters>${marker === undefined ? "" : `<Marker>${marker}</Marker>`}`,
  );
export const errorResponse = (code: string, status = 400) =>
  new Response(
    `<ErrorResponse xmlns="http://rds.amazonaws.com/doc/2014-10-31/"><Error><Type>Sender</Type><Code>${code}</Code><Message>${code}</Message></Error><RequestId>request-id</RequestId></ErrorResponse>`,
    { status, headers: { "content-type": "text/xml" } },
  );
export interface Request {
  action: string;
  parameters: URLSearchParams;
}

// Exercise the provider through distilled's real query protocol and codecs.
export const withGroup = <A, E, R>(
  respond: (request: Request) => Response,
  use: (
    provider: Provider.ProviderService<DBParameterGroup>,
    requests: Request[],
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const requests: Request[] = [];
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        if (request.body._tag !== "Uint8Array")
          throw new Error(`Unexpected body: ${request.body._tag}`);
        const parameters = new URLSearchParams(
          new TextDecoder().decode(request.body.body),
        );
        const recorded = { action: parameters.get("Action") ?? "", parameters };
        requests.push(recorded);
        return HttpClientResponse.fromWeb(request, respond(recorded));
      }),
    );
    return yield* Effect.gen(function* () {
      return yield* use(
        yield* Provider.Provider<DBParameterGroup>(DBParameterGroup.Type),
        requests,
      );
    }).pipe(
      Effect.provide(DBParameterGroupProvider()),
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, http),
          fromCredentials(
            { accessKeyId: "test-key", secretAccessKey: "test-secret" },
            "us-east-1",
          ),
          Layer.succeed(Region, Effect.succeed("us-east-1")),
          Layer.succeed(Stack, {
            name: "parameter-group",
            stage: "test",
            resources: {},
            bindings: {},
            actions: {},
          }),
          Layer.succeed(Stage, "test"),
          Layer.succeed(InstanceId, context.instanceId),
        ),
      ),
    );
  });

export const reconcile = (
  provider: Provider.ProviderService<DBParameterGroup>,
  news: DBParameterGroupProps,
) =>
  provider.reconcile({
    ...context,
    news,
    olds: props,
    output,
    bindings: [],
    session: {
      emit: () => Effect.void,
      done: () => Effect.void,
      note: () => Effect.void,
    },
  });
