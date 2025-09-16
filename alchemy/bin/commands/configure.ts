import {
  confirm,
  group,
  intro,
  isCancel,
  log,
  outro,
  select,
  text,
} from "@clack/prompts";
import pc from "picocolors";
import z from "zod";
import {
  type Credentials,
  getProfile,
  setProviderCredentials,
} from "../../src/auth.ts";
import { CloudflareAuth } from "../../src/cloudflare/auth.ts";
import { authProcedure, CancelSignal } from "../trpc.ts";
import { cloudflareLogin, promptForCloudflareAccount } from "./login.ts";

export const configure = authProcedure
  .meta({
    description: "configure a profile",
  })
  .input(
    z.object({
      profile: z
        .string()
        .default("default")
        .meta({ alias: "p" })
        .describe("the profile to configure"),
    }),
  )
  .mutation(async ({ input }) => {
    intro(pc.cyan(`🧪 Configure profile "${pc.bold(input.profile)}"`));
    const profile = await getProfile(input.profile);
    if (profile) {
      log.info(`Profile: ${pc.bold(input.profile)}`);
      for (const [provider, providerProfile] of Object.entries(profile)) {
        const description = [
          `- ${pc.bold(provider)}: ${providerProfile.metadata.name} (${pc.dim(providerProfile.metadata.id)})`,
          `  - Method: ${pc.dim(providerProfile.method)}`,
          ...(providerProfile.scopes?.length
            ? [`  - Scopes: ${pc.dim(providerProfile.scopes.join(", "))}`]
            : []),
        ];
        log.info(description.join("\n"));
      }
      if (
        (await confirm({
          message: `Update profile ${pc.bold(input.profile)}?`,
          initialValue: false,
        })) !== true
      ) {
        throw new CancelSignal();
      }
    } else {
      if (
        (await confirm({
          message: `Create profile ${pc.bold(input.profile)}?`,
          initialValue: true,
        })) !== true
      ) {
        throw new CancelSignal();
      }
    }
    const method = await select({
      message: `Select a login method for ${pc.bold("Cloudflare")}`,
      options: [
        { label: "OAuth", value: "oauth", hint: "Recommended" },
        { label: "Token", value: "api-token" },
        { label: "API Key", value: "api-key", hint: "Legacy" },
      ],
      initialValue: "oauth" as const,
    });
    if (isCancel(method)) {
      throw new CancelSignal();
    }
    const { credentials, scopes } = await promptForCredentials(method);
    const account = await promptForCloudflareAccount(credentials);
    await setProviderCredentials(
      { profile: input.profile, provider: "cloudflare" },
      {
        credentials,
        provider: {
          method,
          metadata: account,
          scopes,
        },
      },
    );
    outro(pc.green(`✅ Configured profile ${pc.bold(input.profile)}`));
  });
/**
 * Prompts the user to enter credentials for a given method.
 */
const promptForCredentials = async (
  method: "oauth" | "api-token" | "api-key",
): Promise<{ credentials: Credentials; scopes?: string[] }> => {
  switch (method) {
    case "oauth": {
      const customizeScopes = await confirm({
        message: "Customize scopes?",
        initialValue: false,
      });
      let scopes: string[];
      if (customizeScopes) {
        const entry = await text({
          message: "Enter a comma-separated list of scopes",
          validate: (value) => {
            const scopes = value.split(",").map((scope) => scope.trim());
            const invalid = scopes.filter(
              (scope) => !CloudflareAuth.ALL_SCOPES.includes(scope),
            );
            if (invalid.length > 0) {
              return `Invalid scopes: ${invalid.join(", ")}`;
            }
            return undefined;
          },
        });
        if (isCancel(entry)) {
          throw new CancelSignal();
        }
        scopes = entry.split(",").map((scope) => scope.trim());
      } else {
        scopes = CloudflareAuth.DEFAULT_SCOPES;
      }
      return await cloudflareLogin(new Set(scopes));
    }
    case "api-token": {
      const apiToken = await text({
        message: "Enter API token",
      });
      if (isCancel(apiToken)) {
        throw new CancelSignal();
      }
      return {
        credentials: {
          type: "api-token",
          apiToken,
        },
      };
    }
    case "api-key": {
      const { apiKey, email } = await group(
        {
          apiKey: () =>
            text({
              message: "Enter API key",
            }),
          email: () =>
            text({
              message: "Enter API email",
            }),
        },
        {
          onCancel: () => {
            throw new CancelSignal();
          },
        },
      );
      return {
        credentials: {
          type: "api-key",
          apiKey,
          email,
        },
      };
    }
  }
};
