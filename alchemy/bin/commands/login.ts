import { confirm, intro, isCancel, log, outro, select } from "@clack/prompts";
import open from "open";
import pc from "picocolors";
import z from "zod";
import {
  type Credentials,
  getProviderCredentials,
  setProviderCredentials,
} from "../../src/auth.ts";
import { CloudflareAuth } from "../../src/cloudflare/auth.ts";
import { listCloudflareAccounts } from "../../src/cloudflare/user.ts";
import { authProcedure, CancelSignal } from "../trpc.ts";

export const login = authProcedure
  .meta({
    description: "login to a provider",
  })
  .input(
    z.object({
      provider: z
        .enum(["cloudflare"])
        .default("cloudflare")
        .meta({ positional: true })
        .describe("the provider to login to"),
      profile: z
        .string()
        .default("default")
        .meta({ alias: "p" })
        .describe("the profile to login to"),
      scopes: z
        .array(z.string())
        .optional()
        .meta({ alias: "s" })
        .describe("the scopes to login with"),
      excludeDefaultScopes: z
        .boolean()
        .default(false)
        .meta({ alias: "e" })
        .describe("exclude default scopes"),
    }),
  )
  .mutation(async ({ input }) => {
    intro(pc.cyan("🧪 Login"));
    const invalidScopes =
      input.scopes?.filter(
        (scope) => !CloudflareAuth.ALL_SCOPES.includes(scope),
      ) ?? [];
    if (invalidScopes.length > 0) {
      throw new Error(
        `Invalid scopes: ${invalidScopes.join(", ")}. Please specify valid scopes.`,
      );
    }
    const selectedScopes = input.excludeDefaultScopes
      ? new Set(input.scopes ?? [])
      : new Set([...CloudflareAuth.DEFAULT_SCOPES, ...(input.scopes ?? [])]);
    if (selectedScopes.size === 0) {
      throw new Error(
        "No scopes selected. Please specify scopes with --scopes, or remove the --exclude-default-scopes flag.",
      );
    }
    await confirmIfOverwrite(input);
    const { credentials, scopes } = await cloudflareLogin(selectedScopes);
    const account = await promptForCloudflareAccount(credentials);
    await setProviderCredentials<CloudflareAuth.Metadata>(input, {
      credentials,
      provider: {
        metadata: account,
        method: "oauth",
        scopes,
      },
    });
    outro(
      `✅ Signed in to ${input.provider} as ${pc.bold(account.name)} ${pc.dim(`(${account.id})`)}`,
    );
  });

const confirmIfOverwrite = async (input: {
  provider: string;
  profile: string;
}) => {
  const existing = await getProviderCredentials<CloudflareAuth.Metadata>(
    input,
  ).catch(() => undefined);
  if (existing) {
    log.step(
      [
        `Profile "${input.profile}" already includes provider "${input.provider}".`,
        `Account: ${existing.provider.metadata.name} (${existing.provider.metadata.id})`,
        `Credentials: ${existing.credentials.type}`,
      ].join("\n"),
    );
    const overwrite = await confirm({
      message: "Would you like to overwrite?",
      initialValue: false,
    });
    if (overwrite !== true) {
      throw new CancelSignal();
    }
  }
};

export const cloudflareLogin = async (scopes: Set<string>) => {
  scopes.add("offline_access"); // required for refresh tokens
  const authorization = CloudflareAuth.client.authorize(Array.from(scopes));
  log.step(
    [
      "Opening browser to authorize with Cloudflare...",
      "",
      pc.gray(
        "If you are not automatically redirected, please open the following URL in your browser:",
      ),
      authorization.url,
    ].join("\n"),
  );
  await open(authorization.url);
  return await CloudflareAuth.client.callback(authorization);
};

/**
 * Lists Cloudflare accounts and prompts the user to select one.
 */
export const promptForCloudflareAccount = async (credentials: Credentials) => {
  const accounts = await listCloudflareAccounts(
    CloudflareAuth.formatHeaders(credentials),
  );
  const account = await select({
    message: "Select an account",
    options: accounts.map((account) => ({
      label: account.name,
      value: { id: account.id, name: account.name },
      hint: account.id,
    })),
  });
  if (isCancel(account)) {
    throw new CancelSignal();
  }
  return account;
};
