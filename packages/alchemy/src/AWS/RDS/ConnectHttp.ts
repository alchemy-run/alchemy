import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { isFunction } from "../Lambda/Function.ts";
import {
  Connect,
  type ConnectOptions,
  type ConnectResource,
} from "./Connect.ts";

export const ConnectHttp = Layer.effect(
  Connect,
  Effect.gen(function* () {
    const getSecretValue = yield* secretsmanager.getSecretValue;

    return Effect.fn(function* (
      resource: ConnectResource,
      options: ConnectOptions,
    ) {
      const SecretId = yield* options.secret.secretArn;
      const Host = yield* resource.endpoint;
      const Port =
        resource.Type === "AWS.RDS.DBCluster"
          ? yield* resource.port
          : undefined;

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.RDS.Connect(${options.secret}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [
                  "secretsmanager:GetSecretValue",
                  "secretsmanager:DescribeSecret",
                ],
                Resource: [options.secret.secretArn],
              },
            ],
          });
        }
      }

      return Effect.gen(function* () {
        const secretId = yield* SecretId;
        const host = yield* Host;
        const port = Port ? yield* Port : undefined;
        const value = yield* getSecretValue({
          SecretId: secretId,
        });
        const secretString = value.SecretString
          ? typeof value.SecretString === "string"
            ? value.SecretString
            : Redacted.value(value.SecretString)
          : "{}";
        const secret = JSON.parse(secretString) as {
          username?: string;
          password?: string;
        };

        if (!host) {
          return yield* Effect.die(`RDS endpoint is not available yet`);
        }

        return {
          host,
          port: options.port ?? port ?? 5432,
          database: options.database,
          username: secret.username,
          password: secret.password,
          ssl: options.ssl ?? true,
        };
      });
    });
  }),
);
