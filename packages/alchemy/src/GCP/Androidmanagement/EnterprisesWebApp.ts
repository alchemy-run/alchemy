import * as androidmanagement from "@distilled.cloud/gcp/androidmanagement_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_DISPLAY_MODE,
  defaultWebAppIcons,
  encodeOwnershipLine,
  findOwnedWebApp,
  getWebApp,
  hasOwnershipMarker,
  jsonEqual,
  lastSegment,
  listOwnedWebApps,
  MAX_WEB_APP_TITLE_LENGTH,
  ownedByAlchemy,
  ownershipLabels,
  parentOf,
  parseOwnership,
  replaceOnIdentity,
  sameText,
  toDisplayName,
  toEnterpriseName,
  toWebAppName,
  updateMaskOf,
} from "./internal.ts";

export type EnterprisesWebAppProps = {
  /**
   * Parent enterprise (`enterprises/{enterprise}` or `{enterprise}`).
   * Immutable — changing it replaces the web app.
   */
  parent: string;
  /**
   * Start URL loaded when the user opens the app.
   */
  startUrl: string;
  /**
   * Title shown to users. Web apps have no labels field, so Alchemy
   * stores ownership in a `[alchemy …]` prefix and strips it from
   * attributes.
   */
  title?: string;
  /**
   * Display mode (`MINIMAL_UI`, `STANDALONE`, or `FULL_SCREEN`).
   * @default "STANDALONE"
   */
  displayMode?: androidmanagement.WebAppDisplayModeEnum | (string & {});
  /**
   * Icons for the web app. At least one is required; a 1x1 PNG is used
   * when omitted.
   */
  icons?: androidmanagement.WebAppIconList;
};

export type EnterprisesWebApp = Resource<
  "GCP.Androidmanagement.EnterprisesWebApp",
  EnterprisesWebAppProps,
  {
    /** Resource name `enterprises/{enterprise}/webApps/{package}`. */
    name: string;
    /** Web app package id (last path segment). */
    webAppId: string;
    /** Parent enterprise name. */
    parent: string;
    /** Project id used when the web app was reconciled. */
    project: string;
    /** Title with the Alchemy ownership prefix stripped. */
    title: string | undefined;
    /** Start URL. */
    startUrl: string | undefined;
    /** Display mode. */
    displayMode: string | undefined;
    /** Icons. */
    icons: androidmanagement.WebAppIconList | undefined;
    /** Current version code. */
    versionCode: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Android Management web app.
 *
 * Web apps have no labels field, so Alchemy stamps ownership into
 * `title` for `list` / nuke. `parent` is identity — changing it
 * replaces the web app. Title, start URL, display mode, and icons
 * update in place. At least one icon is required by the API; a 1x1 PNG
 * is sent when `icons` is omitted.
 *
 * ### Creating a Web App
 * **Example:** Standalone shortcut
 * ```typescript
 * const app = yield* GCP.Androidmanagement.EnterprisesWebApp("Docs", {
 *   parent: enterprise.name,
 *   startUrl: "https://docs.example.com/",
 *   title: "Docs",
 * });
 * ```
 *
 * **Example:** Full-screen kiosk URL
 * ```typescript
 * const app = yield* GCP.Androidmanagement.EnterprisesWebApp("Kiosk", {
 *   parent: enterprise.name,
 *   startUrl: "https://kiosk.example.com/",
 *   displayMode: "FULL_SCREEN",
 * });
 * ```
 *
 * ### Updating a Web App
 * **Example:** Change the title
 * ```typescript
 * const app = yield* GCP.Androidmanagement.EnterprisesWebApp("Docs", {
 *   parent: existing.parent,
 *   startUrl: existing.startUrl ?? "https://docs.example.com/",
 *   title: "Internal docs",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Androidmanagement
 */
export const EnterprisesWebApp = Resource<EnterprisesWebApp>(
  "GCP.Androidmanagement.EnterprisesWebApp",
);

export class EnterprisesWebAppNotResolved extends Data.TaggedError(
  "GCP.Androidmanagement.EnterprisesWebAppNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (app: androidmanagement.WebApp, project: string) => {
  const name = app.name ?? "";
  return {
    name,
    webAppId: lastSegment(name),
    parent: parentOf(name),
    project,
    title: parseOwnership(app.title).text,
    startUrl: app.startUrl,
    displayMode: app.displayMode,
    icons: app.icons,
    versionCode: app.versionCode,
  };
};

export const EnterprisesWebAppProvider = () =>
  Provider.succeed(EnterprisesWebApp, {
    stables: ["name", "webAppId", "parent", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return replaceOnIdentity({
        previousParent: olds?.parent ?? output?.parent,
        nextParent: news.parent,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = olds?.parent ?? output?.parent ?? "";
      const existing = yield* findOwnedWebApp(id, parent, {
        name: output?.name ?? output?.webAppId,
        startUrl: olds?.startUrl ?? output?.startUrl,
      });
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.title))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const apps = yield* listOwnedWebApps(env.project);
        return apps
          .filter((app) => hasOwnershipMarker(app.title))
          .map((app) => toAttrs(app, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = toEnterpriseName(news.parent);
      const ownership = yield* ownershipLabels(id);
      const title = encodeOwnershipLine(
        ownership,
        yield* toDisplayName(
          id,
          news.title,
          output?.title,
          MAX_WEB_APP_TITLE_LENGTH,
        ),
        MAX_WEB_APP_TITLE_LENGTH,
      );
      const displayMode =
        news.displayMode ?? output?.displayMode ?? DEFAULT_DISPLAY_MODE;
      const icons = defaultWebAppIcons(news.icons ?? output?.icons);
      const desired: androidmanagement.WebApp = {
        title,
        startUrl: news.startUrl,
        displayMode,
        icons,
      };

      let current = yield* findOwnedWebApp(id, parent, {
        name: output?.name ?? output?.webAppId,
        startUrl: news.startUrl ?? output?.startUrl,
      });

      if (current === undefined) {
        const created = yield* androidmanagement
          .createEnterprisesWebApps({
            parent,
            body: desired,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findOwnedWebApp(id, parent, {
                name: output?.name,
                startUrl: news.startUrl,
              }),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new EnterprisesWebAppNotResolved({
          name: toWebAppName(parent, output?.name) || news.startUrl,
        });
      }

      const name = current.name ?? output?.name ?? "";
      const titleChanged = !sameText(current.title, title);
      const urlChanged = !sameText(current.startUrl, news.startUrl);
      const modeChanged = !sameText(current.displayMode, displayMode);
      const iconsChanged =
        news.icons !== undefined && !jsonEqual(current.icons, icons);

      const updateMask = updateMaskOf(
        titleChanged ? "title" : undefined,
        urlChanged ? "startUrl" : undefined,
        modeChanged ? "displayMode" : undefined,
        iconsChanged ? "icons" : undefined,
      );

      if (updateMask.length > 0 && name.length > 0) {
        current = yield* androidmanagement.patchEnterprisesWebApps({
          name,
          updateMask,
          body: desired,
        });
      }

      const fresh = (yield* getWebApp(name)) ?? current;
      return toAttrs(fresh, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.name.length === 0) return;
      yield* androidmanagement
        .deleteEnterprisesWebApps({ name: output.name })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.catchTag("Forbidden", () => Effect.void),
          Effect.catchTag("BadRequest", () => Effect.void),
        );
    }),
  });
