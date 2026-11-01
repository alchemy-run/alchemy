import * as iaas from "@distilled.cloud/stackit/iaas";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { StackitEnvironment } from "../Environment.ts";
import { hasUnresolvedTrigger } from "../internal/diff.ts";
import { sameMembers } from "../internal/equal.ts";
import { isAlchemyOwned } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  ownedOnly,
  projectScopeChanged,
  resolveProjectScope,
  type ProjectScope,
  type ProjectScopedProps,
} from "./internal.ts";

/** `parentOrganization` and `projects` were both set; STACKIT takes one or the other. */
export class ImageShareTargetsConflict extends Data.TaggedError(
  "Stackit.IaaS.ImageShareTargetsConflict",
)<{
  readonly imageId: string;
  readonly message: string;
}> {}

export interface ImageShareProps extends ProjectScopedProps {
  /** Image to share. Changing it replaces the share. */
  imageId: string;
  /**
   * Project ids to share the image with. Updated in place. Cannot be combined
   * with `parentOrganization`.
   */
  projects?: string[];
  /**
   * Share the image with every project in the image owner's organization.
   * Updated in place. Cannot be combined with `projects`.
   * @default false
   */
  parentOrganization?: boolean;
  /**
   * Project owning the image. Defaults to the profile's project. Changing it
   * replaces the share.
   */
  projectId?: string;
  /**
   * Region of the image. Defaults to the profile's region. Changing it
   * replaces the share.
   */
  region?: string;
}

export interface ImageShareAttributes {
  /** The shared image. */
  imageId: string;
  /** Whether every project in the owner's organization can use the image. */
  parentOrganization: boolean;
  /** Projects the image is shared with. */
  projects: string[];
  /** Project owning the image. */
  projectId: string;
  /** Region of the image. */
  region: string;
}

export type ImageShare = Resource<
  "Stackit.IaaS.ImageShare",
  ImageShareProps,
  ImageShareAttributes,
  never,
  Providers
>;

/**
 * Who else can use a STACKIT image: specific projects, or every project in
 * the owner's organization.
 *
 * An image has one share, and deploying this resource replaces it as a whole,
 * including targets added outside Alchemy. Deleting it removes the share, and
 * the image's scope goes back to `local`. Shares have no labels: ownership
 * follows the image, so a share on an image Alchemy doesn't own is reported as
 * unowned and only taken over with `--adopt`.
 *
 * ### Sharing with projects
 * **Example:** Share an image with two projects
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const image = yield* Stackit.IaaS.Image("Base", {
 *   source: { type: "file", path: "./images/base.qcow2" },
 *   diskFormat: "qcow2",
 * });
 * yield* Stackit.IaaS.ImageShare("BaseShare", {
 *   imageId: image.imageId,
 *   projects: [
 *     "00000000-0000-0000-0000-000000000001",
 *     "00000000-0000-0000-0000-000000000002",
 *   ],
 * });
 * ```
 *
 * ### Sharing with the organization
 * **Example:** Share an image with the whole organization
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const image = yield* Stackit.IaaS.Image("Base", {
 *   source: { type: "file", path: "./images/base.qcow2" },
 *   diskFormat: "qcow2",
 * });
 * yield* Stackit.IaaS.ImageShare("BaseShare", {
 *   imageId: image.imageId,
 *   parentOrganization: true,
 * });
 * ```
 *
 * ### Replacement <!-- api-prose -->
 * Changing `imageId`, `projectId` or `region` shares the new image and removes
 * the old share. A new image has a new id, so consumers using the old id keep
 * only what they already built from it.
 *
 * @resource
 * @product STACKIT Compute Engine
 * @category IaaS
 */
export const ImageShare = Resource<ImageShare>("Stackit.IaaS.ImageShare");

const toAttrs = (
  share: iaas.ImageShare | undefined,
  imageId: string,
  scope: ProjectScope,
): ImageShareAttributes => ({
  imageId,
  parentOrganization: share?.parentOrganization ?? false,
  projects: [...(share?.projects ?? [])],
  ...scope,
});

/** The image's share; a missing image also reads as no share. */
const getShare = (scope: ProjectScope, imageId: string) =>
  iaas
    .getImageShare({ ...scope, imageId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const isShared = (share: iaas.ImageShare | undefined) =>
  share?.parentOrganization === true || (share?.projects?.length ?? 0) > 0;

const deleteShare = (scope: ProjectScope, imageId: string) =>
  iaas.deleteImageShare({ ...scope, imageId }).pipe(Effect.catchTag("NotFound", () => Effect.void));

export const ImageShareProvider = () =>
  Provider.succeed(ImageShare, {
    stables: ["imageId", "projectId", "region"],
    nuke: { dependsOn: ["Stackit.IaaS.Image"] },

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const scope = { projectId: env.projectId, region: env.region };
      const { items } = yield* iaas.listImages(scope);
      const shares: ImageShareAttributes[] = [];
      for (const image of ownedOnly(items)) {
        if (image.id === undefined) continue;
        const share = yield* getShare(scope, image.id);
        if (isShared(share)) shares.push(toAttrs(share, image.id, scope));
      }
      return shares;
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // The identity is the image, with no generation marker: an unresolved
      // id can resolve to the current image, so the old share goes first.
      if (hasUnresolvedTrigger<ImageShareProps>(news, ["imageId", "projectId", "region"])) {
        return { action: "replace", deleteFirst: true } as const;
      }
      if (!isResolved(news)) return undefined;
      if (news.imageId !== output.imageId || (yield* projectScopeChanged(news, output))) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output, previous }) {
      const imageId = output?.imageId ?? olds?.imageId;
      if (imageId === undefined) return undefined;
      const scope = yield* resolveProjectScope(olds, output);
      const image = yield* iaas
        .getImage({ ...scope, imageId })
        .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
      if (image === undefined) return undefined;
      const share = yield* getShare(scope, imageId);
      const attrs = toAttrs(share, imageId, scope);
      if (output !== undefined || previous?.imageId === imageId) return attrs;
      if (!isShared(share)) return undefined;
      return isAlchemyOwned(image.labels) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const imageId = news.imageId;
      const parentOrganization = news.parentOrganization === true;
      const projects = news.projects ?? [];
      if (parentOrganization && projects.length > 0) {
        return yield* new ImageShareTargetsConflict({
          imageId,
          message: `Image share for ${imageId} sets both parentOrganization and projects; set only one`,
        });
      }

      // Observe
      const observed = yield* getShare(scope, imageId);
      if (
        (observed?.parentOrganization ?? false) === parentOrganization &&
        sameMembers(observed?.projects, projects)
      ) {
        return toAttrs(observed, imageId, scope);
      }

      // Sync — no targets means no share. `setImageShare` replaces the share,
      // where `updateImageShare` would only append to it, and STACKIT takes
      // one kind of target per request.
      if (!parentOrganization && projects.length === 0) {
        yield* deleteShare(scope, imageId);
        return toAttrs(undefined, imageId, scope);
      }
      const share = yield* iaas.setImageShare({
        ...scope,
        imageId,
        ...(parentOrganization ? { parentOrganization } : { projects: [...projects] }),
      });
      return toAttrs(share, imageId, scope);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* deleteShare({ projectId: output.projectId, region: output.region }, output.imageId);
    }),
  });
