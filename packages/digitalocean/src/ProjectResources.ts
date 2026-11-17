import * as DO from "@distilled.cloud/digitalocean";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { Providers } from "./Providers.ts";

export type ProjectResourcesProps = {
  /** Project to move the resources into. A change moves them to the new project. */
  projectId: string;
  /**
   * Uniform resource names of the resources, for example `droplet.urn`
   * (`do:droplet:<id>`), `volume.urn`, `domain.urn`. A resource dropped
   * from the list moves back to the team's default project.
   */
  resources: string[];
};

export type ProjectResources = Resource<
  "DigitalOcean.ProjectResources",
  ProjectResourcesProps,
  {
    /** Project the resources are in. */
    projectId: string;
    /** URNs this resource moved into the project. */
    resources: string[];
  },
  never,
  Providers
>;

/**
 * Moves resources into a DigitalOcean Project. Every resource belongs to
 * exactly one project, so "removing" a resource moves it back to the
 * team's default project. Destroying this resource moves all of its
 * resources back to the default project; the resources themselves stay.
 *
 * ### Grouping Resources
 * **Example:** Group an app's droplet, volume and domain
 * ```typescript
 * const project = yield* DigitalOcean.Project("shop", { environment: "Production" });
 * const host = yield* DigitalOcean.Droplet("app", {
 *   region: "sfo3",
 *   size: "s-1vcpu-1gb",
 *   image: "ubuntu-24-04-x64",
 * });
 * const domain = yield* DigitalOcean.Domain("shop-domain", { name: "shop.example.com" });
 * yield* DigitalOcean.ProjectResources("shop-resources", {
 *   projectId: project.projectId,
 *   resources: [host.urn, domain.urn],
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/Project-Resources
 *
 * @resource
 * @product Projects
 * @category Management
 */
export const ProjectResources = Resource<ProjectResources>("DigitalOcean.ProjectResources");

const PAGE_SIZE = 200;

const urnsIn = (projectId: string) =>
  DO.listProjectResources.items({ project_id: projectId, per_page: PAGE_SIZE }).pipe(
    Stream.map((resource) => resource.urn),
    Stream.filter((urn): urn is string => urn !== undefined),
    Stream.runCollect,
  );

const assign = (projectId: string, urns: ReadonlyArray<string>) =>
  urns.length === 0
    ? Effect.void
    : DO.assignProjectResources({ project_id: projectId, resources: [...urns] }).pipe(
        Effect.asVoid,
      );

// Every resource belongs to a project, so leaving one means joining the default.
const releaseToDefault = (urns: ReadonlyArray<string>) =>
  urns.length === 0
    ? Effect.void
    : DO.assignProjectResourcesDefault({ resources: [...urns] }).pipe(
        // A resource destroyed in the same deploy is no longer assignable.
        Effect.catchTag("NotFound", () => Effect.void),
        Effect.asVoid,
      );

export const ProjectResourcesProvider = () =>
  Provider.succeed(ProjectResources, {
    stables: [],
    read: Effect.fn(function* ({ olds, output }) {
      const projectId = output?.projectId ?? olds.projectId;
      const present = yield* urnsIn(projectId).pipe(
        Effect.catchTag("NotFound", () => Effect.succeed([] as string[])),
      );
      const ours = Arr.intersection(output?.resources ?? olds.resources, present);
      return ours.length === 0 ? undefined : { projectId, resources: ours };
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      const desired = Arr.dedupe(news.resources);
      const present = yield* urnsIn(news.projectId);
      yield* assign(news.projectId, Arr.difference(desired, present));
      // Resources this resource moved before and no longer lists go back.
      const dropped = Arr.difference(output?.resources ?? [], desired);
      yield* releaseToDefault(dropped);
      return { projectId: news.projectId, resources: desired };
    }),
    delete: Effect.fn(function* ({ output }) {
      const present = yield* urnsIn(output.projectId).pipe(
        Effect.catchTag("NotFound", () => Effect.succeed([] as string[])),
      );
      yield* releaseToDefault(Arr.intersection(output.resources, present));
    }),
  });
