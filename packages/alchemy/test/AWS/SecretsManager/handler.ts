import * as Lambda from "@/AWS/Lambda";
import * as SecretsManager from "@/AWS/SecretsManager";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

// Secrets Manager marks values as sensitive, so the distilled client can hand
// them back either raw or wrapped in `Redacted` — unwrap for JSON transport.
const unwrapString = (
  value: string | Redacted.Redacted<string> | undefined,
): string | undefined =>
  value === undefined
    ? undefined
    : typeof value === "string"
      ? value
      : Redacted.value(value);

const unwrapBinary = (
  value: Uint8Array | Redacted.Redacted<Uint8Array> | undefined,
): Uint8Array | undefined =>
  value === undefined
    ? undefined
    : value instanceof Uint8Array
      ? value
      : Redacted.value(value);

export class SecretsManagerTestFunction extends Lambda.Function<Lambda.Function>()(
  "SecretsManagerTestFunction",
) {}

export default SecretsManagerTestFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    const stringSecret = yield* SecretsManager.Secret("StringSecret", {
      description: "alchemy binding fixture (string value)",
      secretString: Redacted.make("alchemy-sm-fixture-value"),
    });
    // Created without an initial value: the binary round-trip is driven
    // entirely through the PutSecretValue/GetSecretValue bindings.
    const binarySecret = yield* SecretsManager.Secret("BinarySecret", {
      description: "alchemy binding fixture (binary value)",
    });

    const getStringSecret = yield* SecretsManager.GetSecretValue(stringSecret);
    const putStringSecret = yield* SecretsManager.PutSecretValue(stringSecret);
    const getBinarySecret = yield* SecretsManager.GetSecretValue(binarySecret);
    const putBinarySecret = yield* SecretsManager.PutSecretValue(binarySecret);
    const describeStringSecret =
      yield* SecretsManager.DescribeSecret(stringSecret);
    const getRandomPassword = yield* SecretsManager.GetRandomPassword();
    const listSecrets = yield* SecretsManager.ListSecrets();

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/string-value") {
          const result = yield* getStringSecret();
          return yield* HttpServerResponse.json({
            name: result.Name,
            arn: result.ARN,
            versionId: result.VersionId,
            secretString: unwrapString(result.SecretString),
          });
        }

        if (request.method === "POST" && pathname === "/put-string") {
          const body = (yield* request.json) as unknown as { value: string };
          const result = yield* putStringSecret({ SecretString: body.value });
          return yield* HttpServerResponse.json({
            versionId: result.VersionId,
          });
        }

        if (request.method === "POST" && pathname === "/put-binary") {
          const body = (yield* request.json) as unknown as { base64: string };
          const bytes = yield* Effect.sync(
            () => new Uint8Array(Buffer.from(body.base64, "base64")),
          );
          const result = yield* putBinarySecret({ SecretBinary: bytes });
          return yield* HttpServerResponse.json({
            versionId: result.VersionId,
          });
        }

        if (request.method === "GET" && pathname === "/binary-value") {
          const result = yield* getBinarySecret();
          const bytes = unwrapBinary(result.SecretBinary);
          const base64 = bytes
            ? yield* Effect.sync(() => Buffer.from(bytes).toString("base64"))
            : undefined;
          return yield* HttpServerResponse.json({
            versionId: result.VersionId,
            secretString: unwrapString(result.SecretString),
            base64,
          });
        }

        if (request.method === "GET" && pathname === "/describe") {
          const result = yield* describeStringSecret();
          return yield* HttpServerResponse.json({
            name: result.Name,
            arn: result.ARN,
            description: result.Description,
          });
        }

        if (request.method === "GET" && pathname === "/random-password") {
          const length = Number(url.searchParams.get("length") ?? "24");
          const result = yield* getRandomPassword({
            PasswordLength: length,
            ExcludePunctuation: true,
          });
          return yield* HttpServerResponse.json({
            password: unwrapString(result.RandomPassword),
          });
        }

        if (request.method === "GET" && pathname === "/list") {
          const name = url.searchParams.get("name");
          if (!name) {
            return HttpServerResponse.text("Missing name", { status: 400 });
          }
          const result = yield* listSecrets({
            Filters: [{ Key: "name", Values: [name] }],
          });
          return yield* HttpServerResponse.json({
            names: (result.SecretList ?? []).map((entry) => entry.Name),
          });
        }

        return yield* HttpServerResponse.json(
          {
            error: "Not found",
            method: request.method,
            pathname,
          },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        SecretsManager.GetSecretValueHttp,
        SecretsManager.PutSecretValueHttp,
        SecretsManager.DescribeSecretHttp,
        SecretsManager.GetRandomPasswordHttp,
        SecretsManager.ListSecretsHttp,
      ),
    ),
  ),
);
