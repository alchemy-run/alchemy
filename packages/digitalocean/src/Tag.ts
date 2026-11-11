import * as DO from "@distilled.cloud/digitalocean";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ignoreNotFound, noneIfNotFound } from "./internal/notFound.ts";
import { isAlchemyTag } from "./internal/ownership.ts";
import type { Providers } from "./Providers.ts";

export type TagProps = {
  /**
   * Tag name: letters, digits, `:`, `-` and `_`, at most 255 characters.
   * The `alchemy:` prefix is reserved. A change replaces the tag.
   */
  name: string;
};

export type Tag = Resource<
  "DigitalOcean.Tag",
  TagProps,
  {
    /** Tag name. */
    name: string;
    /** Number of resources that carry the tag. */
    resourceCount: number;
  },
  never,
  Providers
>;

/**
 * A DigitalOcean tag. A tag that already exists on the team is `Unowned`
 * and needs `--adopt`. Droplets and volumes create the tags in their
 * `tags` prop on their own; declare a `Tag` when something must exist
 * before any resource carries it, such as a firewall or load balancer that
 * targets every droplet with the tag. Destroying the tag removes it from
 * every resource that carries it.
 *
 * ### Targeting Droplets by Tag
 * **Example:** A firewall for every web droplet, present and future
 * ```typescript
 * const web = yield* DigitalOcean.Tag("web", { name: "web" });
 * yield* DigitalOcean.Firewall("web-firewall", {
 *   tags: [web.name],
 *   inboundRules: [{ protocol: "tcp", ports: "443", addresses: ["0.0.0.0/0", "::/0"] }],
 * });
 * yield* DigitalOcean.Droplet("app", {
 *   region: "sfo3",
 *   size: "s-1vcpu-1gb",
 *   image: "ubuntu-24-04-x64",
 *   tags: [web.name],
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/Tags
 *
 * @resource
 * @product Tags
 * @category Management
 */
export const Tag = Resource<Tag>("DigitalOcean.Tag");

export class TagNameReserved extends Data.TaggedError("DigitalOcean.TagNameReserved")<{
  readonly tag: string;
}> {
  override get message() {
    return `Tag '${this.tag}' uses the 'alchemy:' prefix, which is reserved for ownership tags.`;
  }
}

const observe = (name: string) =>
  noneIfNotFound(DO.getTag({ tag_id: name }).pipe(Effect.map((response) => response.tag)));

const toAttrs = (tag: DO.Tags) => ({
  name: tag.name,
  resourceCount: tag.resources?.count ?? 0,
});

export const TagProvider = () =>
  Provider.succeed(Tag, {
    stables: ["name"],
    // A tag carries no ownership marker.
    nuke: { skip: true },
    // Destroying a tag strips it from every resource, so a tag that
    // already exists needs `--adopt`.
    read: Effect.fn(function* ({ olds, output }) {
      const observed = yield* observe(output?.name ?? olds.name);
      if (Option.isNone(observed)) return undefined;
      const attrs = toAttrs(observed.value);
      return output === undefined ? Unowned(attrs) : attrs;
    }),
    diff: Effect.fn(function* ({ olds, news }) {
      if ("name" in news && news.name !== olds.name) return { action: "replace" } as const;
    }),
    reconcile: Effect.fn(function* ({ news }) {
      if (isAlchemyTag(news.name)) return yield* new TagNameReserved({ tag: news.name });
      const observed = yield* observe(news.name);
      const tag = yield* Option.match(observed, {
        onNone: () => DO.createTag({ name: news.name }).pipe(Effect.map((r) => r.tag)),
        onSome: Effect.succeed,
      });
      return toAttrs(tag);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(DO.deleteTag({ tag_id: output.name }));
    }),
  });
