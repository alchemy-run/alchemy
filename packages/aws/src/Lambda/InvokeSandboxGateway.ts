// A request's body stream and the SDK's failures are carried as the HTTP
// client's own transport error.
/** @effect-diagnostics anyUnknownInErrorContext:off */

import { Credentials } from "@distilled.cloud/aws/Credentials";
import * as Lambda from "@distilled.cloud/aws/lambda";
import { Region, type RegionName } from "@distilled.cloud/aws/Region";
import * as Gateway from "alchemy/Gateway";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import { Random } from "alchemy/Random";
import { packEnvValue } from "alchemy/RuntimeContext";
import { Self } from "alchemy/Self";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { AccessKey } from "../IAM/AccessKey.ts";
import { User } from "../IAM/User.ts";
import { Function as LambdaFunction } from "./Function.ts";

const entry = new URL(
  import.meta.url.endsWith(".ts")
    ? "./InvokeSandboxGatewayEntry.ts"
    : "./InvokeSandboxGatewayEntry.js",
  import.meta.url,
).pathname;

const literal = <A>(value: A) => Output.literal(value) as unknown as Output.Output<A, never>;

const concat = (chunks: ReadonlyArray<Uint8Array>) => {
  const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
};

/** A request's body as bytes: an `Invoke` payload is sent whole. */
const bodyOf = (request: HttpClientRequest.HttpClientRequest) => {
  const body = request.body;
  switch (body._tag) {
    case "Uint8Array":
      return Effect.succeed(body.body);
    case "Stream":
      return Effect.map(Stream.runCollect(body.stream), (chunks) => concat(Array.from(chunks)));
    case "Raw":
      return Effect.succeed(
        typeof body.body === "string" ? new TextEncoder().encode(body.body) : new Uint8Array(),
      );
    default:
      return Effect.succeed(new Uint8Array());
  }
};

/**
 * Runs the sandbox's gateway as a Lambda Function the sandbox calls through
 * the Lambda `Invoke` API. Use it for a sandbox whose network reaches AWS's
 * API endpoints and little else, such as a Daytona sandbox below Tier 3,
 * which can reach neither a Web Function's nor a Worker's URL.
 *
 * `Invoke` requests are signed, so the sandbox holds an access key. The key
 * belongs to an IAM user that may invoke this one Function and nothing
 * else: it is the sandbox's gateway token, in the form AWS accepts. The
 * credentials of the sandbox's bindings stay in the Function.
 *
 * A payload is at most 6 MB each way and is sent whole, so streams are
 * buffered, and a CLI cannot use the gateway as an origin
 * (`GitHub.PushRepository`'s remote). Prefer `AWS.Lambda.SandboxGateway`
 * wherever the sandbox can reach it.
 *
 * @layer
 * @product Function
 * @provides Alchemy.Gateway
 */
export const InvokeSandboxGateway = Layer.effect(
  Gateway.Gateway,
  Effect.gen(function* () {
    // Yielding a resource class erases its `Providers` requirement; the
    // stack satisfies it at plan time.
    const makeRandom = yield* Random;
    const makeUser = yield* User;
    const makeKey = yield* AccessKey;
    let deployed: Gateway.Deployed | undefined;
    let name = literal("");
    let keyId = literal("");
    let keySecret = literal(Redacted.make(""));
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      const sandbox = yield* Self;
      const scoped = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Namespace.push(sandbox.LogicalId, effect);
      const secret = yield* scoped(makeRandom("GatewayToken"));
      const fn = (yield* scoped(
        LambdaFunction(Gateway.gatewayId(sandbox.LogicalId), {
          main: entry,
          handler: "handler",
          timeout: Duration.seconds(60),
          memorySize: 512,
          // Packed like every bound value, so the secret survives the
          // function's plain-string environment.
          env: { [Gateway.TOKEN_KEY]: secret.text.pipe(Output.map(packEnvValue)) },
          build: { plugins: [Gateway.programPlugin(sandbox)] },
        }),
      )) as LambdaFunction;
      // The sandbox's only AWS permission: invoking its own gateway.
      const user = yield* scoped(
        makeUser("GatewayCaller", {
          inlinePolicies: {
            InvokeGateway: {
              Version: "2012-10-17",
              Statement: [
                { Effect: "Allow", Action: ["lambda:InvokeFunction"], Resource: [fn.functionArn] },
              ],
            },
          },
        }),
      );
      const key = yield* scoped(makeKey("GatewayCallerKey", { userName: user.userName }));
      name = fn.functionName as unknown as Output.Output<string, never>;
      keyId = key.accessKeyId as unknown as Output.Output<string, never>;
      keySecret = key.secretAccessKey.pipe(
        Output.map((value) => value ?? Redacted.make("")),
      ) as unknown as Output.Output<Redacted.Redacted<string>, never>;
      deployed = {
        self: fn,
        // The API endpoint the sandbox calls; the Function is named separately.
        url: fn.functionArn.pipe(
          Output.map((arn) => `https://lambda.${arn.split(":")[3]}.amazonaws.com`),
        ) as unknown as Output.Output<string, never>,
        token: secret.text as unknown as Output.Output<Redacted.Redacted<string>, never>,
        set: (key, output) =>
          fn.bind(`Gateway(${key})`, {
            env: { [key]: output.pipe(Output.map(packEnvValue)) },
          }),
      };
    }
    // Bound before the gateway is installed, so they land on the sandbox.
    const functionName = yield* Output.named(name, "ALCHEMY_GATEWAY_FUNCTION").asEffect();
    const accessKeyId = yield* Output.named(keyId, "ALCHEMY_GATEWAY_ACCESS_KEY_ID").asEffect();
    const secretAccessKey = yield* Output.named(
      keySecret,
      "ALCHEMY_GATEWAY_SECRET_ACCESS_KEY",
    ).asEffect();

    const failed = (request: HttpClientRequest.HttpClientRequest, cause: unknown) =>
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({ request, cause }),
      });

    /** An `HttpClient` that sends each request as one `Invoke` of the Function. */
    const client = HttpClient.make((request, url) =>
      Effect.gen(function* () {
        const region = url.host.split(".")[1] as RegionName;
        const body = yield* bodyOf(request);
        const invoked = yield* Lambda.invoke({
          FunctionName: yield* functionName,
          Payload: JSON.stringify({
            method: request.method,
            path: `${url.pathname}${url.search}`,
            headers: request.headers,
            ...(body.length === 0 ? {} : { body: Buffer.from(body).toString("base64") }),
          }),
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(
                Credentials,
                Effect.all([accessKeyId, secretAccessKey]).pipe(
                  Effect.map(([id, secret]) => ({
                    accessKeyId: Redacted.make(id),
                    secretAccessKey: secret,
                    sessionToken: undefined,
                    region,
                  })),
                ),
              ),
              Layer.succeed(Region, Effect.succeed(region)),
              FetchHttpClient.layer,
            ),
          ),
        );
        const payload = invoked.Payload
          ? new TextDecoder().decode(concat(Array.from(yield* Stream.runCollect(invoked.Payload))))
          : "";
        if (invoked.FunctionError !== undefined) {
          return yield* failed(request, `the gateway failed: ${payload}`);
        }
        const answer = JSON.parse(payload) as {
          status: number;
          headers: Record<string, string>;
          body: string;
        };
        const bytes = Buffer.from(answer.body, "base64");
        return HttpClientResponse.fromWeb(
          request,
          new Response(bytes.length === 0 ? null : bytes, {
            status: answer.status,
            headers: answer.headers,
          }),
        );
      }).pipe(
        Effect.mapError((cause) =>
          (cause as { _tag?: string })._tag === "HttpClientError"
            ? (cause as HttpClientError.HttpClientError)
            : failed(request, cause),
        ),
      ),
    );

    return yield* Gateway.make(
      Effect.sync(() => deployed!),
      { type: LambdaFunction.Type, client: Effect.succeed(client) },
    );
  }),
);
