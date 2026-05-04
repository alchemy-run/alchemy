import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Effect from "effect/Effect";
import { deepEqual, isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface AuthorizerProps {
  /**
   * REST API identifier that owns the authorizer.
   */
  restApiId: Input<string>;
  /**
   * Authorizer name.
   *
   * If omitted, Alchemy generates a deterministic physical name.
   */
  name?: string;
  /**
   * Authorizer type.
   */
  type: ag.AuthorizerType;
  /**
   * Cognito user pool ARNs for `COGNITO_USER_POOLS` authorizers.
   */
  providerARNs?: string[];
  /**
   * Custom authorization type label.
   */
  authType?: string;
  /**
   * Lambda invocation URI for `TOKEN` or `REQUEST` authorizers.
   */
  authorizerUri?: string;
  /**
   * IAM role ARN used by API Gateway to invoke the authorizer.
   *
   * This is not secret key material; API Gateway stores the role ARN.
   */
  authorizerCredentials?: string;
  /**
   * Identity source expression, e.g. `method.request.header.Authorization`.
   */
  identitySource?: string;
  /**
   * Validation regex for token authorizers.
   */
  identityValidationExpression?: string;
  /**
   * Cache TTL for authorizer results, in seconds.
   */
  authorizerResultTtlInSeconds?: number;
}

export interface Authorizer extends Resource<
  "AWS.ApiGateway.Authorizer",
  AuthorizerProps,
  {
    authorizerId: string;
    restApiId: string;
    name: string;
    type: ag.AuthorizerType;
  },
  never,
  Providers
> {}

/**
 * REST API Lambda, Cognito, or gateway authorizer.
 *
 * @section Authorizers
 * @example Lambda TOKEN authorizer
 * ```typescript
 * const authorizer = yield* ApiGateway.Authorizer("Auth", {
 *   restApiId: api.restApiId,
 *   type: "TOKEN",
 *   authorizerUri: authorizerInvokeArn,
 *   identitySource: "method.request.header.Authorization",
 * });
 * ```
 */
const AuthorizerResource = Resource<Authorizer>("AWS.ApiGateway.Authorizer");

export { AuthorizerResource as Authorizer };

const generatedName = (id: string, props: AuthorizerProps) =>
  props.name
    ? Effect.succeed(props.name)
    : createPhysicalName({
        id,
        maxLength: 128,
      });

export const AuthorizerProvider = () =>
  Provider.effect(
    AuthorizerResource,
    Effect.gen(function* () {
      return {
        stables: ["authorizerId", "restApiId"] as const,
        diff: Effect.fn(function* ({ news: newsIn, olds }) {
          if (!isResolved(newsIn)) return;
          const news = newsIn as AuthorizerProps;
          if (
            // These fields define the authorizer identity and kind; replacement
            // avoids patching a different authorizer shape in place.
            news.restApiId !== olds.restApiId ||
            (news.name !== undefined && news.name !== olds.name) ||
            news.type !== olds.type
          ) {
            return { action: "replace" } as const;
          }
          if (!deepEqual(news.providerARNs, olds.providerARNs)) {
            return { action: "replace" } as const;
          }
          if (news.authType !== olds.authType) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.authorizerId) return undefined;
          const a = yield* ag
            .getAuthorizer({
              restApiId: output.restApiId,
              authorizerId: output.authorizerId,
            })
            .pipe(
              Effect.catchTag("NotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (!a?.id) return undefined;
          return {
            authorizerId: a.id,
            restApiId: output.restApiId,
            name: a.name!,
            type: a.type!,
          };
        }),
        create: Effect.fn(function* ({ id, news: newsIn, session }) {
          if (!isResolved(newsIn)) {
            return yield* Effect.die("Authorizer props were not resolved");
          }
          const news = newsIn as Input.ResolveProps<AuthorizerProps>;
          const name = yield* generatedName(id, news);
          const a = yield* ag.createAuthorizer({
            restApiId: news.restApiId as string,
            name,
            type: news.type,
            providerARNs: news.providerARNs,
            authType: news.authType,
            authorizerUri: news.authorizerUri,
            authorizerCredentials: news.authorizerCredentials,
            identitySource: news.identitySource,
            identityValidationExpression: news.identityValidationExpression,
            authorizerResultTtlInSeconds: news.authorizerResultTtlInSeconds,
          });
          if (!a.id) return yield* Effect.die("createAuthorizer missing id");
          yield* session.note(`Created authorizer ${a.id}`);
          return {
            authorizerId: a.id,
            restApiId: news.restApiId as string,
            name,
            type: news.type,
          };
        }),
        update: Effect.fn(function* ({ news: newsIn, olds, output, session }) {
          if (!isResolved(newsIn)) {
            return yield* Effect.die("Authorizer props were not resolved");
          }
          const news = newsIn as Input.ResolveProps<AuthorizerProps>;
          const patches: ag.PatchOperation[] = [];
          if (news.authorizerUri !== olds.authorizerUri) {
            patches.push({
              op: news.authorizerUri === undefined ? "remove" : "replace",
              path: "/authorizerUri",
              value: news.authorizerUri,
            });
          }
          if (news.identitySource !== olds.identitySource) {
            patches.push({
              op: news.identitySource === undefined ? "remove" : "replace",
              path: "/identitySource",
              value: news.identitySource,
            });
          }
          if (news.authorizerCredentials !== olds.authorizerCredentials) {
            patches.push({
              op:
                news.authorizerCredentials === undefined ? "remove" : "replace",
              path: "/authorizerCredentials",
              value: news.authorizerCredentials,
            });
          }
          if (
            news.identityValidationExpression !==
            olds.identityValidationExpression
          ) {
            patches.push({
              op:
                news.identityValidationExpression === undefined
                  ? "remove"
                  : "replace",
              path: "/identityValidationExpression",
              value: news.identityValidationExpression,
            });
          }
          if (
            news.authorizerResultTtlInSeconds !==
            olds.authorizerResultTtlInSeconds
          ) {
            patches.push({
              op:
                news.authorizerResultTtlInSeconds === undefined
                  ? "remove"
                  : "replace",
              path: "/authorizerResultTtlInSeconds",
              value:
                news.authorizerResultTtlInSeconds === undefined
                  ? undefined
                  : String(news.authorizerResultTtlInSeconds),
            });
          }
          if (patches.length > 0) {
            yield* ag.updateAuthorizer({
              restApiId: output.restApiId,
              authorizerId: output.authorizerId,
              patchOperations: patches,
            });
          }
          yield* session.note(`Updated authorizer ${output.authorizerId}`);
          const a = yield* ag.getAuthorizer({
            restApiId: output.restApiId,
            authorizerId: output.authorizerId,
          });
          return {
            authorizerId: output.authorizerId,
            restApiId: output.restApiId,
            name: a.name!,
            type: a.type!,
          };
        }),
        delete: Effect.fn(function* ({ output, session }) {
          yield* ag
            .deleteAuthorizer({
              restApiId: output.restApiId,
              authorizerId: output.authorizerId,
            })
            .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
          yield* session.note(`Deleted authorizer ${output.authorizerId}`);
        }),
      };
    }),
  );
