import type { KV } from "cloudflare/resources";
import * as Effect from "effect/Effect";
import { App } from "../../app.ts";
import { CloudflareAccountId, CloudflareApi } from "../api.ts";
import {
  Namespace,
  type NamespaceAttr,
  type NamespaceProps,
} from "./namespace.ts";

export const namespaceProvider = () =>
  Namespace.provider.effect(
    Effect.gen(function* () {
      const app = yield* App;
      const api = yield* CloudflareApi;
      const accountId = yield* CloudflareAccountId;

      const createTitle = (id: string, news: NamespaceProps) =>
        news.title ?? `${app.name}-${id}-${app.stage}`;

      const mapResult = <Props extends NamespaceProps>(
        result: KV.Namespace,
      ): NamespaceAttr<Props> => ({
        title: result.title,
        namespaceId: result.id,
        supportsUrlEncoding: result.supports_url_encoding,
        accountId,
      });

      return {
        diff: ({ id, news, output }) =>
          Effect.sync(() => {
            if (output.accountId !== accountId) {
              return { action: "replace" };
            }
            const title = createTitle(id, news);
            if (title !== output.title) {
              return { action: "update" };
            }
          }),
        create: Effect.fn(function* ({ id, news }) {
          return yield* api.kv.namespaces
            .create({
              account_id: accountId,
              title: createTitle(id, news),
            })
            .pipe(Effect.map(mapResult<NamespaceProps>));
        }),
        update: Effect.fn(function* ({ id, news, output }) {
          return yield* api.kv.namespaces
            .update(output.namespaceId, {
              account_id: accountId,
              title: createTitle(id, news),
            })
            .pipe(Effect.map(mapResult<NamespaceProps>));
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* api.kv.namespaces
            .delete(output.namespaceId, {
              account_id: output.accountId,
            })
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          if (output?.namespaceId) {
            return yield* api.kv.namespaces
              .get(output.namespaceId, {
                account_id: output.accountId,
              })
              .pipe(
                Effect.map(mapResult<NamespaceProps>),
                Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
              );
          }
          const title = createTitle(id, olds ?? {}); // why is olds optional?
          let page = 1;
          while (true) {
            // todo: abstract pagination
            const namespaces = yield* api.kv.namespaces.list({
              account_id: accountId,
              page,
              per_page: 100,
            });
            const match = namespaces.result.find(
              (namespace) => namespace.title === title,
            );
            if (match) {
              return mapResult<NamespaceProps>(match);
            }
            if (namespaces.nextPageInfo()) {
              page++;
            } else {
              return undefined;
            }
          }
        }),
      };
    }),
  );
