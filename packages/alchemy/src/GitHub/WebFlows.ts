import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import type { Locator, Page } from "playwright-core";
import { GitHubBrowser, guard, type GitHubBrowserError } from "./Browser.ts";

export type RepositorySelection = "all" | "selected";
export type PermissionAccess = "none" | "read" | "write" | "admin";

export type WebFlow<Input> = (
  input: Input,
) => Effect.Effect<void, GitHubBrowserError, GitHubBrowser>;

const webFlow =
  <Input>(
    url: (input: Input) => string,
    drive: (page: Page, input: Input) => Promise<void>,
  ): WebFlow<Input> =>
  (input) =>
    GitHubBrowser.use((browser) =>
      browser.page(url(input), (page) => drive(page, input)),
    );

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const pathOf = (page: Page) => new URL(page.url()).pathname;

const SAVE_CHANGES = "Save changes";
const ERROR_FLASH = ".flash-error, .Banner--error";

const openCollapsedGroups = (element: HTMLElement) => {
  for (
    let group = element.closest("details");
    group;
    group = group.parentElement?.closest("details") ?? null
  ) {
    group.open = true;
  }
};

const failIfRejected = async (page: Page) => {
  const error = page.locator(ERROR_FLASH).filter({ visible: true });
  if ((await error.count()) > 0) {
    throw new Error(
      `GitHub rejected the change on ${page.url()}: ${(await error.first().innerText()).trim()}`,
    );
  }
};

const submitAndAwait = async (
  page: Page,
  pathFragment: string,
  submit: () => Promise<void>,
  confirm?: Locator,
) => {
  const origin = new URL(page.url()).origin;
  const posted = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().startsWith(origin) &&
      new URL(response.url()).pathname.includes(pathFragment),
  );
  await submit();
  if (confirm !== undefined) {
    const outcome = await Promise.race([
      posted.then(() => "posted" as const),
      confirm.waitFor({ state: "visible" }).then(() => "confirm" as const),
    ]);
    if (outcome === "confirm") await confirm.click();
  }
  const response = await posted;
  if (response.status() >= 400) {
    throw new Error(
      `Saving changes on ${page.url()} failed with HTTP ${response.status()}`,
    );
  }
  await page.waitForLoadState();
  await guard(page);
  await failIfRejected(page);
};

// The provider's localhost manifest page auto-submits to {origin}/settings/apps/new
const MANIFEST = {
  create: /^Create GitHub App/,
} as const;

const MANIFEST_GAP = Duration.seconds(30);
const manifestTurn = Semaphore.makeUnsafe(1);
let nextManifestAt = 0;

const awaitManifestTurn = manifestTurn.withPermits(1)(
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const wait = Math.max(nextManifestAt - now, 0);
    nextManifestAt = now + wait + Duration.toMillis(MANIFEST_GAP);
    yield* Effect.sleep(Duration.millis(wait));
  }),
);

export const registerAppFromManifestPage = async (
  page: Page,
  input: { readonly manifestUrl: string },
): Promise<void> => {
  const local = new URL(input.manifestUrl).origin;
  await page.waitForURL((url) => url.origin !== local);
  await guard(page);
  await page.getByRole("button", { name: MANIFEST.create }).click();
  await guard(page);
  await page.waitForURL((url) => url.origin === local);
};

/** Submit the manifest page and wait for GitHub to redirect back to it. */
export const registerAppFromManifest: WebFlow<{
  readonly manifestUrl: string;
}> = (input) =>
  Effect.andThen(
    awaitManifestTurn,
    webFlow(
      (input: { readonly manifestUrl: string }) => input.manifestUrl,
      registerAppFromManifestPage,
    )(input),
  );

// {owner settings}/apps/{slug}/advanced
const DELETE_APP = {
  open: "Delete GitHub App",
  confirm: /delete this GitHub App/i,
} as const;

export const deleteAppPage = async (
  page: Page,
  input: { readonly advancedUrl: string; readonly slug: string },
): Promise<void> => {
  await page.getByRole("button", { name: DELETE_APP.open }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox").fill(input.slug);
  await dialog.getByRole("button", { name: DELETE_APP.confirm }).click();
  await guard(page);
  await page.waitForURL((url) => !url.pathname.includes(`/apps/${input.slug}`));
};

export const deleteApp = webFlow(
  (input: { readonly advancedUrl: string; readonly slug: string }) =>
    input.advancedUrl,
  deleteAppPage,
);

// Repository picker on /installations/new/permissions and /settings/installations/{id}
const REPOSITORY_PICKER = {
  all: "#install_target_all",
  selected: "#install_target_selected",
  open: "Select repositories",
  search: "Search for a repository",
  item: "#repository-menu-list button.select-menu-item",
  itemName: "strong",
  picked: "div.js-repository-picker-result",
  pickedName: "span.repo-and-owner",
  remove: (repository: string) => `Remove ${repository}`,
  selectedField: "input.js-selected-repository-field",
} as const;

export interface RepositorySelectionInput {
  readonly repositorySelection: RepositorySelection;
  readonly repositories?: ReadonlyArray<string>;
}

const pickedRepositories = async (page: Page) =>
  (
    await page
      .locator(REPOSITORY_PICKER.picked)
      .locator(REPOSITORY_PICKER.pickedName)
      .allInnerTexts()
  ).map((text) => text.trim().split("/").pop() ?? "");

const applyRepositorySelection = async (
  page: Page,
  input: RepositorySelectionInput,
) => {
  if (input.repositorySelection === "all") {
    await page.locator(REPOSITORY_PICKER.all).check();
    return;
  }
  const wanted = input.repositories ?? [];
  if (wanted.length === 0) {
    throw new Error(
      "repositorySelection 'selected' needs at least one repository",
    );
  }
  await page.locator(REPOSITORY_PICKER.selected).check();
  for (const repository of await pickedRepositories(page)) {
    if (!wanted.includes(repository)) {
      await page
        .getByRole("button", {
          name: REPOSITORY_PICKER.remove(repository),
          exact: true,
        })
        .click();
    }
  }
  const present = await pickedRepositories(page);
  for (const repository of wanted) {
    if (present.includes(repository)) continue;
    const search = page.getByPlaceholder(REPOSITORY_PICKER.search);
    if (!(await search.isVisible())) {
      await page.getByText(REPOSITORY_PICKER.open, { exact: true }).click();
    }
    await search.fill(repository);
    await page
      .locator(REPOSITORY_PICKER.item)
      .filter({
        has: page.locator(REPOSITORY_PICKER.itemName, {
          hasText: new RegExp(`^/${escapeRegExp(repository)}$`),
        }),
      })
      .click();
  }
  await page
    .locator(REPOSITORY_PICKER.selectedField)
    .nth(wanted.length - 1)
    .waitFor({ state: "attached" });
};

// /apps/{slug}/installations/new (account picker) and /installations/new/permissions?target_id=
const INSTALL = {
  accountLink: 'a[href*="/installations/new/permissions?target_id="]',
  submit: 'button[data-octo-click="install_integration"]',
} as const;

export interface InstallAppInput extends RepositorySelectionInput {
  readonly installUrl: string;
  readonly account: string;
}

export const installAppPage = async (
  page: Page,
  input: InstallAppInput,
): Promise<void> => {
  if (/\/installations\/new\/?$/.test(pathOf(page))) {
    await page
      .locator(INSTALL.accountLink)
      .filter({ hasText: input.account })
      .first()
      .click();
    await guard(page);
  }
  await applyRepositorySelection(page, input);
  await page.locator(INSTALL.submit).click();
  await guard(page);
  await page.waitForURL((url) => !url.pathname.includes("/installations/new"));
};

export const installApp = webFlow(
  (input: InstallAppInput) => input.installUrl,
  installAppPage,
);

// /settings/installations/{id}/permissions/update
const ACCEPT_PERMISSIONS = {
  accept: /Accept new permissions/i,
} as const;

export const acceptInstallationPermissionsPage = async (
  page: Page,
  _input: { readonly reviewUrl: string },
): Promise<void> => {
  const accept = page.getByRole("button", { name: ACCEPT_PERMISSIONS.accept });
  await accept.click();
  await accept.waitFor({ state: "detached" });
  await guard(page);
  await failIfRejected(page);
};

export const acceptInstallationPermissions = webFlow(
  (input: { readonly reviewUrl: string }) => input.reviewUrl,
  acceptInstallationPermissionsPage,
);

// /settings/installations/{id} (Repository access)
const INSTALLATION_SETTINGS = {
  save: "button.js-integrations-install-form-submit",
  updatePath: "/settings/installations/",
} as const;

export interface InstallationRepositorySelectionInput extends RepositorySelectionInput {
  readonly settingsUrl: string;
}

export const setInstallationRepositorySelectionPage = async (
  page: Page,
  input: InstallationRepositorySelectionInput,
): Promise<void> => {
  await applyRepositorySelection(page, input);
  await submitAndAwait(page, INSTALLATION_SETTINGS.updatePath, () =>
    page.locator(INSTALLATION_SETTINGS.save).click(),
  );
  await page.goto(input.settingsUrl);
  await guard(page);
  const radio = page.locator(
    input.repositorySelection === "all"
      ? REPOSITORY_PICKER.all
      : REPOSITORY_PICKER.selected,
  );
  if (!(await radio.isChecked())) {
    throw new Error(
      `Saving the repository selection did not take effect on ${page.url()}`,
    );
  }
};

export const setInstallationRepositorySelection = webFlow(
  (input: InstallationRepositorySelectionInput) => input.settingsUrl,
  setInstallationRepositorySelectionPage,
);

// {owner settings}/apps/{slug} (General)
const APP_SETTINGS = {
  name: "#integration_name",
  description: "#integrator_description",
  url: "#integration_url",
  postPath: "/settings/apps/",
} as const;

export interface AppSettingsInput {
  readonly settingsUrl: string;
  readonly name?: string;
  readonly description?: string;
  readonly url?: string;
}

export const updateAppSettingsPage = async (
  page: Page,
  input: AppSettingsInput,
): Promise<void> => {
  if (input.name !== undefined) {
    await page.locator(APP_SETTINGS.name).fill(input.name);
  }
  if (input.description !== undefined) {
    await page.locator(APP_SETTINGS.description).fill(input.description);
  }
  if (input.url !== undefined) {
    await page.locator(APP_SETTINGS.url).fill(input.url);
  }
  await submitAndAwait(page, APP_SETTINGS.postPath, () =>
    page.getByRole("button", { name: SAVE_CHANGES }).first().click(),
  );
};

export const updateAppSettings = webFlow(
  (input: AppSettingsInput) => input.settingsUrl,
  updateAppSettingsPage,
);

// {owner settings}/apps/{slug}/permissions
const APP_PERMISSIONS = {
  item: (permission: string, access: PermissionAccess) =>
    `#integration_permission_${permission}_${access}`,
  menu: 'ul[role="menu"]',
  events: "input.js-integration-hook-event",
  confirm: /^Save/,
  postPath: "/settings/apps/",
} as const;

export interface AppPermissionsInput {
  readonly permissionsUrl: string;
  /** Permission key as in the REST API (e.g. `issues`); `none` drops it. */
  readonly permissions: Record<string, PermissionAccess>;
  /** Webhook events to subscribe to; omit to leave them untouched. */
  readonly events?: ReadonlyArray<string>;
}

const selectPermission = async (
  page: Page,
  permission: string,
  access: PermissionAccess,
) => {
  const item = page.locator(APP_PERMISSIONS.item(permission, access));
  if ((await item.count()) === 0) {
    throw new Error(
      `GitHub App permission '${permission}' has no '${access}' option on ${page.url()}`,
    );
  }
  if ((await item.getAttribute("aria-checked")) === "true") return;
  await item.evaluate(openCollapsedGroups);
  const menu = page.locator(APP_PERMISSIONS.menu, { has: item });
  await page
    .locator(`[id="${await menu.getAttribute("aria-labelledby")}"]`)
    .click();
  await item.click();
};

const selectEvents = async (page: Page, events: ReadonlyArray<string>) => {
  const wanted = new Set(events);
  for (const box of await page.locator(APP_PERMISSIONS.events).all()) {
    const event = (await box.getAttribute("value")) ?? "";
    const desired = wanted.has(event);
    if ((await box.isChecked()) === desired) continue;
    if (!(await box.isVisible())) {
      if (desired) {
        throw new Error(
          `Event '${event}' cannot be subscribed on ${page.url()}: grant the permission it requires first`,
        );
      }
      continue;
    }
    await box.setChecked(desired);
  }
};

export const updateAppPermissionsPage = async (
  page: Page,
  input: AppPermissionsInput,
): Promise<void> => {
  for (const [permission, access] of Object.entries(input.permissions)) {
    await selectPermission(page, permission, access);
  }
  if (input.events !== undefined) await selectEvents(page, input.events);
  await submitAndAwait(
    page,
    APP_PERMISSIONS.postPath,
    () => page.getByRole("button", { name: SAVE_CHANGES }).click(),
    page.getByRole("button", { name: APP_PERMISSIONS.confirm }).last(),
  );
};

export const updateAppPermissions = webFlow(
  (input: AppPermissionsInput) => input.permissionsUrl,
  updateAppPermissionsPage,
);
