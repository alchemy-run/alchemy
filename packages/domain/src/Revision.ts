import * as Output from "alchemy/Output";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import type { Host } from "./DurableObjects.ts";

/** A model's consumers, as the deploy that hosts it binds them. */
export interface RevisionBinding {
  /** The model's name. */
  model: string;
  /** Every view and projection in the model, by target id (`view:Name`, with `#<generation>` once rebuilt). */
  consumers: string[];
}

/** One model's revision. */
export interface ModelRevision {
  /** One on the first deploy, and one more on each deploy that changes `consumers`. */
  revision: number;
  /** The consumers the revision was counted for. */
  consumers: string[];
}

export interface RevisionAttrs {
  /** Each model bound to it, by name. A model no longer bound keeps its last revision. */
  models: Record<string, ModelRevision>;
}

const RevisionTypeId = "Domain.Revision";

/**
 * The revision of Domain models' consumers: one more on each deploy that
 * adds, removes or rebuilds a view or projection of a model. The platform
 * declares it, each model it hosts binds its consumers onto it, and the
 * platform hands the counts to the code it deploys: you don't declare it
 * yourself.
 *
 * ### Why a model counts its revisions <!-- api-prose -->
 *
 * A host keeps running the code from before a deploy for a while after it:
 * Cloudflare moves each Durable Object once it has been idle, a Rivet pool
 * keeps its older nodes, and an Effect Cluster rolls its runners. An object
 * that lists itself in the backfill's directory after a backfill read its
 * directory node gets that backfill's mark, with its revision. When the
 * revision is newer than the code the object runs, the object waits until it
 * runs that code, and then asks the new consumer for a reader. A consumer
 * removed since has a mark from older code, and is never waited on.
 *
 * @resource
 * @product Domain
 */
export interface Revision extends Resource<
  typeof RevisionTypeId,
  {},
  RevisionAttrs,
  RevisionBinding
> {}

export const Revision = Resource<Revision>(RevisionTypeId);

const sameConsumers = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  [...a].sort().join("|") === [...b].sort().join("|");

/** Count each bound model's revision on from the one recorded. */
export const countRevisions = (
  recorded: Readonly<Record<string, ModelRevision>> | undefined,
  bound: ReadonlyArray<RevisionBinding>,
): Record<string, ModelRevision> => {
  const models: Record<string, ModelRevision> = { ...recorded };
  const counted = new Set<string>();
  for (const { model, consumers } of bound) {
    // The same model bound twice (two runtimes host it) counts once.
    if (counted.has(model)) continue;
    counted.add(model);
    const before = recorded?.[model];
    models[model] = {
      revision:
        before === undefined
          ? 1
          : sameConsumers(before.consumers, consumers)
            ? before.revision
            : before.revision + 1,
      consumers: [...consumers],
    };
  }
  return models;
};

/** What a platform binds into its code's environment: each model's revision, by name. */
export const revisionCounts = (
  models: Readonly<Record<string, ModelRevision>>,
): Record<string, number> =>
  Object.fromEntries(Object.entries(models).map(([model, { revision }]) => [model, revision]));

export const RevisionProvider = () =>
  Provider.succeed(Revision, {
    // The revisions are counted here: what was recorded stands.
    read: Effect.fn(function* ({ output }) {
      return output;
    }),
    reconcile: Effect.fn(function* ({ output, bindings }) {
      return {
        models: countRevisions(
          output?.models,
          bindings.map((b) => b.data),
        ),
      };
    }),
    delete: Effect.fn(function* () {}),
  });

/**
 * The revisions of the models one class hosts, on a platform whose class is
 * deployed with an environment (a Rivet Durable Object, an Effect Cluster
 * entity). `phase` runs in the class phase: while deploying it declares the
 * class's {@link Revision} and binds its counts into the class's environment,
 * and at runtime it reads them back. `host` is the platform host's `revision`.
 *
 * @internal
 */
export const classRevisions = (name: string) => {
  let resource: Revision | undefined;
  let counts: Readonly<Record<string, number>> | undefined;
  const phase = Effect.gen(function* () {
    const ctx = yield* RuntimeContext;
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      resource = (yield* Revision(`${name}DomainRevision`, {})) as Revision;
    }
    const bound = yield* ctx.set(
      `DOMAIN_REVISIONS_${name}`,
      resource === undefined
        ? Output.literal(undefined)
        : resource.models.pipe(Output.map(revisionCounts)),
    );
    counts = yield* ctx.get<Readonly<Record<string, number>>>(bound);
  });
  const host: NonNullable<Host["revision"]> = {
    // Each model on the class binds its consumers: the next deploy counts them.
    deploy: ({ modelName }, consumers) =>
      resource === undefined
        ? Effect.void
        : resource.bind`${modelName}`({ model: modelName, consumers: [...consumers] }),
    current: ({ modelName }) => {
      const revision = counts?.[modelName];
      return typeof revision === "number" ? revision : undefined;
    },
  };
  return { phase, host };
};
