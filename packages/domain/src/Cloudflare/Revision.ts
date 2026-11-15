import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";

export interface RevisionProps {
  /** Every view and projection in the model, by target id (`view:Name`, with `#<generation>` once rebuilt). */
  consumers: string[];
}

export interface RevisionAttrs {
  /** One on the first deploy, and one more on each deploy that changes `consumers`. */
  revision: number;
  /** The consumers the revision was counted for. */
  consumers: string[];
}

const RevisionTypeId = "Cloudflare.Domain.Revision";

/**
 * The revision of a Domain model's consumers: one more on each deploy that
 * adds, removes or rebuilds a view or projection. The Durable Object platform
 * declares it with the model and binds it into the Worker: you don't declare
 * it yourself.
 *
 * ### Why a model counts its revisions <!-- api-prose -->
 *
 * Cloudflare moves each Durable Object to the code of a deploy once it has
 * been idle, so for a while after a deploy some objects run the code from
 * before it. An object that lists itself in the backfill's directory after a
 * backfill read its directory node gets that backfill's mark, with its
 * revision. When the revision is newer than the code the object runs, the
 * object waits until it runs that code, and then asks the new consumer for a
 * reader. A consumer removed since has a mark from older code, and is never
 * waited on.
 *
 * @resource
 * @product Durable Objects
 */
export interface Revision extends Resource<typeof RevisionTypeId, RevisionProps, RevisionAttrs> {}

export const Revision = Resource<Revision>(RevisionTypeId);

const sameConsumers = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  [...a].sort().join("|") === [...b].sort().join("|");

export const RevisionProvider = () =>
  Provider.succeed(Revision, {
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return { action: "update" } as const;
      if (!sameConsumers(olds.consumers, news.consumers)) return { action: "update" } as const;
    }),
    // The revision is counted here: what was recorded stands.
    read: Effect.fn(function* ({ output }) {
      return output;
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      const revision =
        output === undefined
          ? 1
          : sameConsumers(output.consumers, news.consumers)
            ? output.revision
            : output.revision + 1;
      return { revision, consumers: [...news.consumers] };
    }),
    delete: Effect.fn(function* () {}),
  });
