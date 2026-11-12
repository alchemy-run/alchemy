import * as deployment from "@distilled.cloud/convex/deployment";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { fromDeployment } from "./Credentials.ts";
import { GONE, isConvexCloudUrl, onDeployment } from "./internal/deployment.ts";
import { envChanges, envHash } from "./internal/env.ts";
import type { Providers } from "./Providers.ts";

export interface EnvironmentVariablesProps {
  /** The deployment's URL. */
  url: string;
  /** A deploy key or admin key with `deployment:env:view` and `deployment:env:write`. */
  token: Redacted.Redacted<string>;
  /** The variables to set. */
  env: Record<string, string | Redacted.Redacted<string>>;
}

export interface EnvironmentVariablesAttributes {
  /** The names this resource set, which are the only ones it will delete. */
  managed: string[];
  /** Changes when any variable does. Keyed, so it reveals nothing about a value. */
  hash: string;
}

export type EnvironmentVariables = Resource<
  "Convex.EnvironmentVariables",
  EnvironmentVariablesProps,
  EnvironmentVariablesAttributes,
  never,
  Providers
>;

/**
 * Environment variables on a Convex deployment. Serves both Convex Cloud and
 * self-hosted backends. `Convex.Functions` creates one of these, so most stacks
 * never use it directly.
 *
 * Values go through the Deployment API rather than `convex env set`, which
 * would put them in `argv`.
 *
 * @resource
 * @product EnvironmentVariables
 */
export const EnvironmentVariables = Resource<EnvironmentVariables>("Convex.EnvironmentVariables");

const on = (url: string, token: Redacted.Redacted<string>) =>
  Effect.provide(fromDeployment({ url, token }));

const plain = (env: EnvironmentVariablesProps["env"]) =>
  Object.fromEntries(
    Object.entries(env).map(([name, value]) => [
      name,
      Redacted.isRedacted(value) ? Redacted.value(value) : value,
    ]),
  );

export const EnvironmentVariablesProvider = () =>
  Provider.effect(
    EnvironmentVariables,
    Effect.succeed({
      diff: Effect.fn(function* ({ news }) {
        if (!isResolved(news)) return undefined;
      }),
      read: Effect.fn(function* ({ output }) {
        return output;
      }),
      reconcile: Effect.fn(function* ({ news, output, session }) {
        const desired = plain(news.env);

        // Observe the deployment, never `olds`: someone may have changed a value.
        const { environmentVariables: observed } = yield* deployment
          .listEnvironmentVariables({})
          .pipe(on(news.url, news.token));

        // Sync
        const changes = envChanges(observed, desired, output?.managed ?? []);
        if (changes.length > 0) {
          yield* session.note(`Updating ${changes.length} environment variables...`);
          yield* deployment.updateEnvironmentVariables({ changes }).pipe(on(news.url, news.token));
        }
        const hash = yield* Effect.sync(() => envHash(desired, Redacted.value(news.token)));
        return { managed: Object.keys(desired).toSorted(), hash };
      }),
      // Variables live on their deployment and go with it.
      list: () => Effect.succeed([]),
      delete: Effect.fn(function* ({ olds, output, session }) {
        const changes = output.managed.map((name) => ({ name, value: null }));
        if (changes.length === 0) return;
        const update = deployment.updateEnvironmentVariables({ changes });
        yield* update.pipe(
          on(olds.url, olds.token),
          // The deploy key may have been revoked. On Convex Cloud the team
          // token can still clean up, and if it's refused too, the delete
          // fails. A self-hosted backend never sees the team token.
          Effect.catchTag(["Unauthorized", "MalformedAccessToken"], (error) =>
            isConvexCloudUrl(olds.url) ? onDeployment(olds.url, update) : Effect.fail(error),
          ),
          // A deployment that has gone took its variables with it.
          Effect.catchTag(GONE, () => Effect.void),
          // Convex won't remove a variable the pushed auth config reads. That
          // can't block a destroy, and the deployment usually goes next.
          Effect.catchTag("AuthConfigMissingEnvironmentVariable", () =>
            session.note("Left variables in place: the pushed auth config reads them."),
          ),
        );
      }),
    }),
  );
