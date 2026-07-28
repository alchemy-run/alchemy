import { Resource } from "alchemy";
import { deepEqual, isResolved } from "alchemy/Diff";
import { Docker, dockerPhysicalName } from "alchemy/Docker";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import type { Providers } from "./Providers.ts";

export interface ContextProps {
  /** Context name. Defaults to generated physical name. */
  name?: string;
  /** Human-readable description displayed in `docker context ls`. */
  description?: string;
  /** Docker endpoint URL, for example `host=ssh://user@host`. */
  docker?: string;
}

export interface Context extends Resource<
  "Docker.Context",
  ContextProps,
  {
    id: string;
    name: string;
    description: string;
    docker?: string;
  },
  never,
  Providers
> {}

export const Context = Resource<Context>("Docker.Context");

export const ContextProvider = () =>
  Provider.effect(
    Context,
    Effect.gen(function* () {
      const docker = yield* Docker;

      const inspect = (nameOrId: string) =>
        docker.context
          .inspect(nameOrId)
          .pipe(
            Effect.catchReason(
              "PlatformError",
              "NotFound",
              () => Effect.undefined,
            ),
          );

      return Context.Provider.of({
        list: () => Effect.succeed([]),
        read: Effect.fn(function* ({ id, instanceId, olds, output }) {
          const name = yield* dockerPhysicalName(id, olds, instanceId);
          const live = yield* inspect(name);
          if (!live) return undefined;
          const attrs = toContextAttributes(live);
          if (output) return attrs;
          return attrs;
        }),
        diff: Effect.fn(function* ({ id, instanceId, news, olds }) {
          if (!isResolved(news)) return undefined;

          const oldDesired = yield* normalizeDesired(id, olds, instanceId);
          const newDesired = yield* normalizeDesired(id, news, instanceId);

          if (oldDesired.name !== newDesired.name) {
            return { action: "replace" as const, deleteFirst: true };
          }

          // `docker context update` can set docker host, but cannot reliably
          // clear it once set. Recreate when transitioning to no docker.
          if (oldDesired.docker && !newDesired.docker) {
            return { action: "replace" as const, deleteFirst: true };
          }

          if (!Equal.equals(oldDesired, newDesired)) {
            return { action: "update" as const };
          }

          return { action: "noop" as const };
        }),
        reconcile: Effect.fn(function* ({
          id,
          instanceId,
          news,
          olds,
          output,
        }) {
          const desired = yield* normalizeDesired(id, news, instanceId);

          if (output && olds) {
            const oldDesired = yield* normalizeDesired(id, olds, instanceId);
            if (deepEqual(oldDesired, desired)) {
              const current = yield* inspect(output.id);
              if (current) {
                return toContextAttributes(current);
              }
            }
          }

          const existing = output
            ? yield* inspect(output.id)
            : yield* inspect(desired.name);

          if (!existing) {
            const createArgs = {
              name: desired.name,
              ...(desired.docker ? { docker: desired.docker } : {}),
              ...(desired.description.length > 0
                ? { description: desired.description }
                : {}),
            };
            yield* docker.context.create(createArgs);
            return toContextAttributes(
              yield* docker.context.inspect(desired.name),
            );
          }

          const current = toContextAttributes(existing);
          const needsUpdate =
            current.description !== desired.description ||
            current.docker !== desired.docker;

          if (needsUpdate) {
            yield* docker.context.update({
              name: desired.name,
              ...(desired.docker ? { docker: desired.docker } : {}),
              description: desired.description,
            });
          }

          return toContextAttributes(
            yield* docker.context.inspect(desired.name),
          );
        }),
        delete: Effect.fn(({ output }) =>
          docker.context.remove(output.id, true).pipe(
            Effect.catchReason("PlatformError", "NotFound", () => Effect.void),
            Effect.as(undefined),
          ),
        ),
      });
    }),
  );

const normalizeDesired = (
  id: string,
  props: ContextProps,
  instanceId: string,
) =>
  dockerPhysicalName(id, props, instanceId).pipe(
    Effect.map((name) => ({
      name,
      description: normalizeDescription(props.description),
      docker: normalizeDocker(props.docker),
    })),
  );

const normalizeDescription = (description: string | undefined): string =>
  description?.trim() ?? "";

const normalizeDocker = (docker: string | undefined): string | undefined => {
  const value = docker?.trim();
  return value && value.length > 0 ? value : undefined;
};

const toContextAttributes = (
  context: Docker.Context,
): Context["Attributes"] => ({
  id: context.Name,
  name: context.Name,
  description: context.Metadata?.Description ?? "",
  docker: context.Endpoints?.docker,
});
