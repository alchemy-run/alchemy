import * as Effect from "effect/Effect";
import { deepEqual, isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  activeRevisionId,
  deleteEndpoint,
  endpointIdentityChanged,
  getEndpoint,
  syncEndpoint,
  toEndpointName,
  type WebFunctionAuthType,
} from "./WebFunctionEndpointSync.ts";

export const WebFunctionEndpointTypeId = "AWS.Lambda.WebFunctionEndpoint" as const;
export type WebFunctionEndpointTypeId = typeof WebFunctionEndpointTypeId;

export interface WebFunctionEndpointProps {
  /**
   * The Web Function this endpoint serves — pass the `AWS.Lambda.WebFunction`
   * resource. The endpoint routes all traffic to the function's latest
   * revision and follows it on every deploy. Changing the function
   * recreates the endpoint, which gets a new URL.
   */
  function: {
    functionName: string;
    revisionId: string;
  };
  /**
   * Name of the endpoint. Your server receives it in the
   * `lambda-web-endpoint-name` request header. Letters, digits, `-` and
   * `_`, up to 64 characters. Changing it recreates the endpoint, which gets
   * a new URL.
   * @default the logical ID
   */
  endpointName?: string;
  /**
   * Who may call the endpoint. `"ApplicationManaged"` forwards every request
   * (a public endpoint; authenticate in your application). `"IamAuth"`
   * requires SigV4-signed requests from principals with
   * `lambda:InvokeWebFunctionEndpoint`. Changes apply in place.
   */
  authType: WebFunctionAuthType;
  /**
   * Additional AWS Regions to serve from. When set, the endpoint is
   * `MultiRegion`: one global domain with latency-based routing across the
   * home Region and these Regions. Changing it recreates the endpoint, which
   * gets a new URL.
   */
  regions?: string[];
  /**
   * Maximum number of execution environments this endpoint uses per Region
   * (2–10,000). Endpoints scale independently. Changes apply in place.
   */
  maxEnvironments?: number;
  /**
   * Maximum requests per second this endpoint accepts, enforced per Region.
   * Excess requests receive HTTP 429; `0` disables the endpoint. Changes
   * apply in place.
   */
  rateLimit?: number;
  /**
   * Description of the endpoint.
   */
  description?: string;
}

export interface WebFunctionEndpoint extends Resource<
  WebFunctionEndpointTypeId,
  WebFunctionEndpointProps,
  {
    /** Name of the Web Function the endpoint serves. */
    functionName: string;
    /** Name of the endpoint. */
    endpointName: string;
    /** ARN of the endpoint, the resource for `lambda:InvokeWebFunctionEndpoint`. */
    endpointArn: string;
    /** Lambda-allocated domain of the endpoint. */
    domainName: string;
    /** HTTPS URL of the endpoint (`https://<domainName>`). */
    url: string;
    /** Revision receiving all of the endpoint's traffic. */
    revisionId: string;
  },
  never,
  Providers
> {}

/**
 * An additional HTTPS endpoint for an `AWS.Lambda.WebFunction`.
 *
 * Every Web Function has a built-in endpoint, configured on the function.
 * Add a `WebFunctionEndpoint` for each extra way in: its own URL, auth type,
 * environment cap, and rate limit. Endpoints scale independently of each
 * other but serve the same code, so a burst on one can't use up another's
 * environments. Your server tells them apart by the
 * `lambda-web-endpoint-name` request header, which callers can't forge.
 *
 * ### Adding an endpoint
 * **Example:** A public webhook endpoint next to a private one
 * ```typescript
 * const api = yield* AWS.Lambda.WebFunction("Api", {
 *   main: "./src/server.ts",
 *   authType: "IamAuth",
 * });
 *
 * const webhooks = yield* AWS.Lambda.WebFunctionEndpoint("Webhooks", {
 *   function: api,
 *   authType: "ApplicationManaged",
 *   rateLimit: 100,
 *   maxEnvironments: 2,
 * });
 *
 * webhooks.url; // https://<id>.<shard>.lambda-web.<region>.on.aws
 * ```
 *
 * ### Routing by endpoint
 * **Example:** Serve only webhook routes on the public endpoint
 * ```typescript
 * // src/server.ts
 * export default {
 *   async fetch(request: Request) {
 *     const endpoint = request.headers.get("lambda-web-endpoint-name");
 *     const { pathname } = new URL(request.url);
 *     if (endpoint === "Webhooks" && !pathname.startsWith("/webhooks/")) {
 *       return new Response("Not Found", { status: 404 });
 *     }
 *     return new Response("ok");
 *   },
 * };
 * ```
 *
 * @resource
 */
export const WebFunctionEndpoint = Resource<WebFunctionEndpoint>(WebFunctionEndpointTypeId);

export const WebFunctionEndpointProvider = () =>
  Provider.effect(
    WebFunctionEndpoint,
    Effect.gen(function* () {
      const nameOf = (id: string, props: { endpointName?: string } | undefined) =>
        props?.endpointName ?? toEndpointName(id);

      const toAttributes = (
        functionName: string,
        endpoint: {
          endpointName: string;
          endpointArn: string;
          domainName: string;
          revisionWeights: { revisionId: string; weight: number }[];
        },
      ): WebFunctionEndpoint["Attributes"] => ({
        functionName,
        endpointName: endpoint.endpointName,
        endpointArn: endpoint.endpointArn,
        domainName: endpoint.domainName,
        url: `https://${endpoint.domainName}`,
        revisionId: activeRevisionId(endpoint),
      });

      return {
        stables: ["functionName", "endpointName", "endpointArn"],
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          if (!isResolved(news)) return;
          if (!output || !olds) return undefined;
          // A different function, name, type, or Region set is a different
          // endpoint (and URL). The name is shared with the old endpoint on
          // the same function, so the old one must go first.
          const sameFunction = news.function.functionName === output.functionName;
          const sameName = nameOf(id, news) === output.endpointName;
          if (!sameFunction || !sameName) {
            return { action: "replace" };
          }
          if (endpointIdentityChanged(olds, news)) {
            return { action: "replace", deleteFirst: true };
          }
          if (deepEqual(olds, news)) return { action: "noop" };
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const functionName = output?.functionName ?? olds?.function.functionName;
          if (functionName === undefined) return undefined;
          const endpointName = output?.endpointName ?? nameOf(id, olds);
          const endpoint = yield* getEndpoint(functionName, endpointName);
          // Endpoints carry their function's tags: ownership follows the
          // function's.
          return endpoint === undefined ? undefined : toAttributes(functionName, endpoint);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const functionName = news.function.functionName;
          const endpointName = output?.endpointName ?? nameOf(id, news);
          const endpoint = yield* syncEndpoint({
            functionName,
            spec: {
              endpointName,
              authType: news.authType,
              regions: news.regions,
              maxEnvironments: news.maxEnvironments,
              rateLimit: news.rateLimit,
              description: news.description,
            },
            revisionId: news.function.revisionId,
            session,
          });
          yield* session.note(`https://${endpoint.domainName}`);
          return toAttributes(functionName, endpoint);
        }),
        delete: Effect.fn(function* ({ output }) {
          // Deleting the function deletes its endpoints too; a missing
          // function or endpoint is already deleted.
          yield* deleteEndpoint(output.functionName, output.endpointName);
        }),
      };
    }),
  );
