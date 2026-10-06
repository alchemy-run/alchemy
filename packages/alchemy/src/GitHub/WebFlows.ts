import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import type { Dialog, Locator, Page } from "playwright-core";
import { GitHubBrowser, guard, type GitHubBrowserError } from "./Browser.ts";

export type RepositorySelection = "all" | "selected";
export type PermissionAccess = "none" | "read" | "write" | "admin";

export type WebFlow<Input, A = void> = (
  input: Input,
) => Effect.Effect<A, GitHubBrowserError, GitHubBrowser>;

const webFlow =
  <Input, A = void>(
    url: (input: Input) => string,
    drive: (page: Page, input: Input) => Promise<A>,
  ): WebFlow<Input, A> =>
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

class ChangeRejected extends Error {
  constructor(
    readonly url: string,
    readonly flash: string,
  ) {
    super(`GitHub rejected the change on ${url}: ${flash}`);
  }
}

const failIfRejected = async (page: Page) => {
  const error = page.locator(ERROR_FLASH).filter({ visible: true });
  if ((await error.count()) > 0) {
    throw new ChangeRejected(
      page.url(),
      (await error.first().innerText()).trim(),
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

// /settings/installations/{id} (Danger zone: Suspend / Unsuspend)
const INSTALLATION_SUSPENSION = {
  submit: 'form[action$="/suspended"] [type=submit]',
  suspendedForm:
    'form[action$="/suspended"]:has(input[name="_method"][value="delete"])',
  postPath: "/suspended",
} as const;

export interface InstallationSuspensionInput {
  readonly settingsUrl: string;
  readonly suspended: boolean;
}

const showsSuspended = async (page: Page) => {
  await page.locator(INSTALLATION_SUSPENSION.submit).first().waitFor({
    state: "attached",
  });
  return (
    (await page.locator(INSTALLATION_SUSPENSION.suspendedForm).count()) > 0
  );
};

export const setInstallationSuspensionPage = async (
  page: Page,
  input: InstallationSuspensionInput,
): Promise<void> => {
  if ((await showsSuspended(page)) === input.suspended) return;
  const accept = (dialog: Dialog) => void dialog.accept();
  page.on("dialog", accept);
  try {
    await submitAndAwait(page, INSTALLATION_SUSPENSION.postPath, () =>
      page.locator(INSTALLATION_SUSPENSION.submit).first().click(),
    );
  } finally {
    page.off("dialog", accept);
  }
  await page.goto(input.settingsUrl);
  await guard(page);
  if ((await showsSuspended(page)) !== input.suspended) {
    throw new Error(
      `${input.suspended ? "Suspending" : "Unsuspending"} the installation did not take effect on ${page.url()}`,
    );
  }
};

export const setInstallationSuspension = webFlow(
  (input: InstallationSuspensionInput) => input.settingsUrl,
  setInstallationSuspensionPage,
);

// {owner settings}/apps/{slug}/advanced (Make public / Make private)
const APP_VISIBILITY = {
  form: (visibility: "public" | "private") =>
    `form[action$="/${visibility}"]:has([type=submit])`,
  submit: "[type=submit]",
} as const;

export interface ReadAppVisibilityInput {
  readonly advancedUrl: string;
  readonly slug: string;
}

export interface AppVisibilityInput extends ReadAppVisibilityInput {
  readonly public: boolean;
}

export type AppVisibilityOutcome =
  | { readonly set: true }
  | { readonly set: false; readonly reason: string };

/**
 * Whether the Advanced settings page shows the app as public. The page
 * offers only the opposite of the current visibility.
 */
export const readAppVisibilityPage = async (
  page: Page,
  input: ReadAppVisibilityInput,
): Promise<boolean> => {
  if ((await page.locator(APP_VISIBILITY.form("private")).count()) > 0) {
    return true;
  }
  if ((await page.locator(APP_VISIBILITY.form("public")).count()) > 0) {
    return false;
  }
  throw new Error(`No visibility control for ${input.slug} on ${page.url()}`);
};

export const readAppVisibility = webFlow<ReadAppVisibilityInput, boolean>(
  (input) => input.advancedUrl,
  readAppVisibilityPage,
);

/**
 * Make the app public or private, confirmed by reloading the page. GitHub
 * may refuse, e.g. to make an app private while it is installed on other
 * accounts; the outcome then carries its reason.
 */
export const setAppVisibilityPage = async (
  page: Page,
  input: AppVisibilityInput,
): Promise<AppVisibilityOutcome> => {
  if ((await readAppVisibilityPage(page, input)) === input.public) {
    return { set: true };
  }
  const wanted = input.public ? "public" : "private";
  const form = page.locator(APP_VISIBILITY.form(wanted)).first();
  const submit = form.locator(APP_VISIBILITY.submit).first();
  if (await submit.isDisabled()) {
    return { set: false, reason: "the control is disabled" };
  }
  const action = new URL((await form.getAttribute("action")) ?? "", page.url())
    .pathname;
  const accept = (dialog: Dialog) => void dialog.accept();
  page.on("dialog", accept);
  try {
    await submitAndAwait(page, action, () => submit.click());
  } catch (error) {
    if (error instanceof ChangeRejected) {
      return { set: false, reason: error.flash };
    }
    throw error;
  } finally {
    page.off("dialog", accept);
  }
  await page.goto(input.advancedUrl);
  await guard(page);
  if ((await readAppVisibilityPage(page, input)) !== input.public) {
    throw new Error(
      `Making ${input.slug} ${wanted} did not take effect on ${page.url()}`,
    );
  }
  return { set: true };
};

export const setAppVisibility = webFlow(
  (input: AppVisibilityInput) => input.advancedUrl,
  setAppVisibilityPage,
);

// {owner settings}/apps/{slug} (General: callback URLs, setup URL, webhook Active)
const APP_GENERAL = {
  callbackRow: ".js-application-callback-url",
  callbackUrl:
    'input[name^="integration[application_callback_urls_attributes]"][name$="[url]"]',
  addCallbackUrl: "Add redirect URI",
  deleteCallbackUrl: "Delete",
  requestOauthOnInstall: "#integration_request_oauth_on_install",
  setupUrl: "#integration_setup_url",
  setupOnUpdate: "#integration_setup_on_update",
  webhookActive: '[id="integration[hook_attributes][active]"]',
} as const;

/** General settings that no API reads or writes after registration. */
export interface AppGeneralSettings {
  readonly callbackUrls: string[];
  readonly requestOauthOnInstall: boolean;
  readonly setupUrl: string | undefined;
  readonly setupOnUpdate: boolean;
  readonly webhookActive: boolean;
}

export interface ReadAppGeneralSettingsInput {
  readonly settingsUrl: string;
}

/**
 * General settings to converge to. The setup URL is left alone while
 * `requestOauthOnInstall` is set, since GitHub disables it then.
 */
export type DesiredAppGeneralSettings = Omit<
  AppGeneralSettings,
  "webhookActive"
> & {
  /** Omit to leave the webhook's Active checkbox untouched. */
  readonly webhookActive?: boolean;
};

export interface SyncAppGeneralSettingsInput {
  readonly settingsUrl: string;
  /** Omit to leave the app name untouched. */
  readonly name?: string;
  /** Omit to leave the description untouched. */
  readonly description?: string;
  /** Omit to leave the homepage URL untouched. */
  readonly url?: string;
  readonly desired: DesiredAppGeneralSettings;
}

export interface AppGeneralSettingsDriftField {
  readonly field:
    | "callbackUrls"
    | "setupUrl"
    | "setupOnUpdate"
    | "requestOauthOnInstall"
    | "webhookActive";
  readonly desired: unknown;
  readonly live: unknown;
}

/**
 * Differences between desired and observed General settings. Callback URL
 * order is irrelevant. The setup URL only counts while OAuth on install is
 * off, since GitHub disables it then, and the webhook's Active checkbox
 * only when one is desired.
 */
export const appGeneralSettingsFormDrift = (
  desired: DesiredAppGeneralSettings,
  observed: AppGeneralSettings,
): AppGeneralSettingsDriftField[] => {
  const fields: AppGeneralSettingsDriftField[] = [];
  const wantedUrls = [...desired.callbackUrls].sort();
  const liveUrls = [...observed.callbackUrls].sort();
  if (
    wantedUrls.length !== liveUrls.length ||
    wantedUrls.some((url, i) => url !== liveUrls[i])
  ) {
    fields.push({
      field: "callbackUrls",
      desired: desired.callbackUrls,
      live: observed.callbackUrls,
    });
  }
  if (
    !desired.requestOauthOnInstall &&
    (desired.setupUrl || undefined) !== (observed.setupUrl || undefined)
  ) {
    fields.push({
      field: "setupUrl",
      desired: desired.setupUrl,
      live: observed.setupUrl,
    });
  }
  if (desired.setupOnUpdate !== observed.setupOnUpdate) {
    fields.push({
      field: "setupOnUpdate",
      desired: desired.setupOnUpdate,
      live: observed.setupOnUpdate,
    });
  }
  if (desired.requestOauthOnInstall !== observed.requestOauthOnInstall) {
    fields.push({
      field: "requestOauthOnInstall",
      desired: desired.requestOauthOnInstall,
      live: observed.requestOauthOnInstall,
    });
  }
  if (
    desired.webhookActive !== undefined &&
    desired.webhookActive !== observed.webhookActive
  ) {
    fields.push({
      field: "webhookActive",
      desired: desired.webhookActive,
      live: observed.webhookActive,
    });
  }
  return fields;
};

const callbackRows = (page: Page) =>
  page.locator(APP_GENERAL.callbackRow).filter({ visible: true });

const callbackRowUrls = async (rows: Locator) => {
  const urls: string[] = [];
  for (const row of await rows.all()) {
    urls.push((await row.locator(APP_GENERAL.callbackUrl).inputValue()).trim());
  }
  return urls;
};

const readAppGeneralSettingsForm = async (
  page: Page,
): Promise<AppGeneralSettings> => {
  const oauth = page.locator(APP_GENERAL.requestOauthOnInstall);
  await oauth.waitFor({ state: "attached" });
  const callbackUrls = (await callbackRowUrls(callbackRows(page))).filter(
    (url) => url !== "",
  );
  const setupUrl = (
    await page.locator(APP_GENERAL.setupUrl).inputValue()
  ).trim();
  return {
    callbackUrls,
    requestOauthOnInstall: await oauth.isChecked(),
    setupUrl: setupUrl === "" ? undefined : setupUrl,
    setupOnUpdate: await page.locator(APP_GENERAL.setupOnUpdate).isChecked(),
    webhookActive: await page.locator(APP_GENERAL.webhookActive).isChecked(),
  };
};

// Rows are filled first, added at the end next, and deleted last from the
// bottom up, so the index of every row still to visit never shifts. A row
// without a Delete button (the last one left) is cleared instead.
const applyCallbackUrls = async (
  page: Page,
  desired: ReadonlyArray<string>,
) => {
  const rows = callbackRows(page);
  const urls = await callbackRowUrls(rows);
  const missing = desired.filter((url) => !urls.includes(url));
  const stale: number[] = [];
  for (const [index, url] of urls.entries()) {
    if (url !== "" && desired.includes(url)) continue;
    const next = missing.shift();
    if (next !== undefined) {
      await rows.nth(index).locator(APP_GENERAL.callbackUrl).fill(next);
    } else if (url !== "") {
      stale.push(index);
    }
  }
  for (const url of missing) {
    await page
      .getByRole("button", { name: APP_GENERAL.addCallbackUrl })
      .click();
    await rows.last().locator(APP_GENERAL.callbackUrl).fill(url);
  }
  for (const index of stale.reverse()) {
    const row = rows.nth(index);
    const remove = row.getByRole("button", {
      name: APP_GENERAL.deleteCallbackUrl,
    });
    if ((await remove.count()) > 0) {
      await remove.click();
    } else {
      await row.locator(APP_GENERAL.callbackUrl).fill("");
    }
  }
};

export const readAppGeneralSettings = webFlow(
  (input: ReadAppGeneralSettingsInput) => input.settingsUrl,
  readAppGeneralSettingsForm,
);

const identityChanges = async (
  page: Page,
  input: SyncAppGeneralSettingsInput,
) => {
  const changes: Array<readonly [Locator, string]> = [];
  for (const [selector, value] of [
    [APP_SETTINGS.name, input.name],
    [APP_SETTINGS.description, input.description],
    [APP_SETTINGS.url, input.url],
  ] as const) {
    if (value === undefined) continue;
    const field = page.locator(selector);
    if ((await field.inputValue()) !== value) changes.push([field, value]);
  }
  return changes;
};

/**
 * Make the General settings, and the name, description and homepage URL
 * when given, match the input in one save, saving only when something
 * differs. Resolves the settings the page shows afterwards.
 */
export const syncAppGeneralSettingsPage = async (
  page: Page,
  input: SyncAppGeneralSettingsInput,
): Promise<AppGeneralSettings> => {
  const { desired } = input;
  const observed = await readAppGeneralSettingsForm(page);
  const drift = new Set(
    appGeneralSettingsFormDrift(desired, observed).map((f) => f.field),
  );
  const identity = await identityChanges(page, input);
  if (drift.size === 0 && identity.length === 0) return observed;
  for (const [field, value] of identity) await field.fill(value);
  if (drift.has("callbackUrls")) {
    await applyCallbackUrls(page, desired.callbackUrls);
  }
  // The setup URL is disabled while OAuth on install is checked.
  await page
    .locator(APP_GENERAL.requestOauthOnInstall)
    .setChecked(desired.requestOauthOnInstall);
  if (!desired.requestOauthOnInstall) {
    await page.locator(APP_GENERAL.setupUrl).fill(desired.setupUrl ?? "");
  }
  await page
    .locator(APP_GENERAL.setupOnUpdate)
    .setChecked(desired.setupOnUpdate);
  if (desired.webhookActive !== undefined) {
    await page
      .locator(APP_GENERAL.webhookActive)
      .setChecked(desired.webhookActive);
  }
  await submitAndAwait(page, APP_SETTINGS.postPath, () =>
    page.getByRole("button", { name: SAVE_CHANGES }).first().click(),
  );
  await page.goto(input.settingsUrl);
  await guard(page);
  return readAppGeneralSettingsForm(page);
};

export const syncAppGeneralSettings = webFlow(
  (input: SyncAppGeneralSettingsInput) => input.settingsUrl,
  syncAppGeneralSettingsPage,
);
