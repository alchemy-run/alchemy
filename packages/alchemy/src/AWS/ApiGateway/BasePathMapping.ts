import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

const normalizeBasePath = (basePath: string | undefined) =>
  basePath === undefined || basePath === "" ? "(none)" : basePath;

export interface BasePathMappingProps {
  domainName: string;
  domainNameId?: string;
  /**
   * Base path segment; omit or empty string for root mapping (`(none)` in API Gateway).
   */
  basePath?: string;
  restApiId: Input<string>;
  stage?: string;
}

export interface BasePathMapping extends Resource<
  "AWS.ApiGateway.BasePathMapping",
  BasePathMappingProps,
  {
    domainName: string;
    domainNameId: string | undefined;
    basePath: string;
    restApiId: string;
    stage: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Maps a custom domain name path to a REST API stage.
 *
 * @section Custom domain
 * @example Root mapping
 * ```typescript
 * yield* ApiGateway.BasePathMapping("Root", {
 *   domainName: domain.domainName,
 *   restApiId: api.restApiId,
 *   stage: stage.stageName,
 * });
 * ```
 */
const BasePathMappingResource = Resource<BasePathMapping>(
  "AWS.ApiGateway.BasePathMapping",
);

export { BasePathMappingResource as BasePathMapping };

export const BasePathMappingProvider = () =>
  Provider.effect(
    BasePathMappingResource,
    Effect.gen(function* () {
      return {
        stables: ["domainName", "domainNameId", "basePath"] as const,
        diff: Effect.fn(function* ({ news: newsIn, olds }) {
          if (!isResolved(newsIn)) return;
          const news = newsIn as Input.ResolveProps<BasePathMappingProps>;
          if (
            news.domainName !== olds.domainName ||
            normalizeBasePath(news.basePath) !==
              normalizeBasePath(olds.basePath)
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output) return undefined;
          const b = yield* ag
            .getBasePathMapping({
              domainName: output.domainName,
              basePath: output.basePath,
              domainNameId: output.domainNameId,
            })
            .pipe(
              Effect.catchTag("NotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (!b?.restApiId) return undefined;
          return {
            domainName: output.domainName,
            basePath: output.basePath,
            domainNameId: output.domainNameId,
            restApiId: b.restApiId,
            stage: b.stage,
          };
        }),
        create: Effect.fn(function* ({ news: newsIn, session }) {
          if (!isResolved(newsIn)) {
            return yield* Effect.die("BasePathMapping props were not resolved");
          }
          const news = newsIn as Input.ResolveProps<BasePathMappingProps>;
          const basePath = normalizeBasePath(news.basePath);
          yield* ag.createBasePathMapping({
            domainName: news.domainName,
            domainNameId: news.domainNameId,
            basePath: basePath === "(none)" ? undefined : news.basePath,
            restApiId: news.restApiId as string,
            stage: news.stage,
          });
          yield* session.note(
            `Created base path mapping ${news.domainName} / ${basePath}`,
          );
          const b = yield* ag.getBasePathMapping({
            domainName: news.domainName,
            basePath,
            domainNameId: news.domainNameId,
          });
          return {
            domainName: news.domainName,
            domainNameId: news.domainNameId,
            basePath,
            restApiId: b.restApiId!,
            stage: b.stage,
          };
        }),
        update: Effect.fn(function* ({ news: newsIn, output, session }) {
          if (!isResolved(newsIn)) {
            return yield* Effect.die("BasePathMapping props were not resolved");
          }
          const news = newsIn as Input.ResolveProps<BasePathMappingProps>;
          const patches: ag.PatchOperation[] = [
            ...(news.restApiId !== output.restApiId
              ? [
                  {
                    op: "replace" as const,
                    path: "/restApiId",
                    value: news.restApiId as string,
                  },
                ]
              : []),
            ...(news.stage !== output.stage
              ? [
                  {
                    op: "replace" as const,
                    path: "/stage",
                    value: news.stage ?? "",
                  },
                ]
              : []),
          ];
          if (patches.length > 0) {
            yield* ag.updateBasePathMapping({
              domainName: output.domainName,
              basePath: output.basePath,
              domainNameId: output.domainNameId,
              patchOperations: patches,
            });
          }
          yield* session.note(`Updated base path mapping`);
          const b = yield* ag.getBasePathMapping({
            domainName: output.domainName,
            basePath: output.basePath,
            domainNameId: output.domainNameId,
          });
          return {
            domainName: output.domainName,
            domainNameId: output.domainNameId,
            basePath: output.basePath,
            restApiId: b.restApiId!,
            stage: b.stage,
          };
        }),
        delete: Effect.fn(function* ({ output, session }) {
          yield* ag
            .deleteBasePathMapping({
              domainName: output.domainName,
              basePath: output.basePath,
              domainNameId: output.domainNameId,
            })
            .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
          yield* session.note(`Deleted base path mapping`);
        }),
      };
    }),
  );
