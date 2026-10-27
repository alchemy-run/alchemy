import * as Entire from "@distilled.cloud/entire";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { makeClient, slugName, waitUntilGone } from "./internal/Client.ts";
import type { Providers } from "./Providers.ts";

export type OrgProps = {
  /**
   * Name: lowercase letters, digits, `.` and `-`. Entire has no rename
   * operation, so changing it replaces the org.
   * @default a unique name generated from the stack, stage and logical ID
   */
  name?: string;
  /**
   * Jurisdiction that stores the org's data (`us`, `eu`, `uk`, `au`, `br`,
   * `in`, `sg`). Changing it replaces the org.
   * @default the deploying account's home jurisdiction
   */
  region?: string;
};

export type Org = Resource<
  "Entire.Org",
  OrgProps,
  {
    /** Org ID (ULID). */
    id: string;
    /** Display name. */
    name: string;
    /** Jurisdiction that stores the org's data. */
    region: string;
    /** When the org was created. */
    createdAt: string;
  },
  never,
  Providers
>;

/**
 * An Entire organization: owns projects, service accounts and members. The
 * deploying account becomes its owner.
 *
 * Entire has no labels, so Alchemy recognises its orgs by the ID it stored;
 * an org found only by name is reported as unowned and needs `--adopt`.
 * `alchemy nuke` does not list orgs for the same reason.
 *
 * ### Creating an Org
 * **Example:** An org with a project and a CI service account
 * ```typescript
 * const org = yield* Entire.Org("acme", { name: "acme" });
 * const project = yield* Entire.Project("app", { orgId: org.id });
 * const ci = yield* Entire.ServiceAccount("ci", { orgId: org.id });
 * ```
 *
 * **Example:** An org stored in the EU
 * ```typescript
 * const org = yield* Entire.Org("acme-eu", { name: "acme-eu", region: "eu" });
 * ```
 *
 * @resource
 * @product Org
 */
export const Org = Resource<Org>("Entire.Org");

const toAttrs = (org: Entire.orgs.Org) => ({
  id: org.id,
  name: org.name,
  region: org.region,
  createdAt: org.createdAt,
});

export const OrgProvider = () =>
  Provider.effect(
    Org,
    Effect.gen(function* () {
      const client = yield* makeClient;

      const orgName = (id: string, props: OrgProps) =>
        props.name ? Effect.succeed(props.name) : slugName(id, 63);

      const get = (orgId: string) => client.core(Entire.orgs.getOrg({ orgId }));

      const findByName = (name: string) =>
        client.core(
          Entire.orgs.listOrgs.items({}).pipe(
            Stream.filter((org) => org.name === name),
            Stream.runHead,
            Effect.map(Option.getOrUndefined),
          ),
        );

      return {
        stables: ["id", "region", "createdAt"],
        // Orgs carry no labels; see the resource docs.
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ id, news, output }) {
          if (!isResolved(news) || !output) return undefined;
          if ((yield* orgName(id, news)) !== output.name) return { action: "replace" } as const;
          if (news.region && news.region !== output.region) return { action: "replace" } as const;
          return undefined;
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          if (output?.id) {
            const org = yield* get(output.id).pipe(
              Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
            );
            return org ? toAttrs(org) : undefined;
          }
          const found = yield* findByName(yield* orgName(id, olds ?? {}));
          return found ? Unowned(toAttrs(found)) : undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, output }) {
          const name = yield* orgName(id, news);
          const observed = output?.id
            ? yield* get(output.id).pipe(
                Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
              )
            : yield* findByName(name);
          if (observed) return toAttrs(observed);
          return toAttrs(yield* client.core(Entire.orgs.createOrg({ name, region: news.region })));
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* client
            .core(Entire.orgs.deleteOrg({ orgId: output.id }))
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
          yield* waitUntilGone(get(output.id), `org ${output.name}`);
        }),
      };
    }),
  );
