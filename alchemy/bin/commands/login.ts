import { confirm, intro, log, outro } from "@clack/prompts";
import open from "open";
import pc from "picocolors";
import z from "zod";
import { Credentials, Provider } from "../../src/auth.ts";
import { CloudflareAuth } from "../../src/cloudflare/auth.ts";
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
    }),
  )
  .mutation(async ({ input }) => {
    intro(pc.cyan("🧪 Login"));
    const provider = await Provider.get<CloudflareAuth.Metadata>(input);
    if (!provider) {
      outro(
        pc.red(
          [
            `❌ ${pc.bold(input.provider)} is not configured on profile "${pc.bold(input.profile)}".`,
            "Please run `alchemy configure` to configure this provider.",
          ].join("\n"),
        ),
      );
      return;
    }
    if (provider.method !== "oauth") {
      outro(
        pc.red(
          [
            `❌ ${pc.bold(input.provider)} is not configured to use OAuth.`,
            "If you would like to use OAuth, please run `alchemy configure` to switch your login method.",
          ].join("\n"),
        ),
      );
      return;
    }
    if (!provider.scopes || provider.scopes.length === 0) {
      outro(
        pc.red(
          [
            `❌ ${pc.bold(input.provider)} is not configured with any scopes.`,
            "Please run `alchemy configure` to configure this provider.",
          ].join("\n"),
        ),
      );
      return;
    }
    await confirmIfOverwrite(input);
    const credentials = await cloudflareLogin(provider.scopes);
    await Credentials.set(input, credentials);
    outro(
      `✅ Signed in to ${input.provider} as ${pc.bold(provider.metadata.name)} ${pc.dim(`(${provider.metadata.id})`)}`,
    );
  });

const confirmIfOverwrite = async (input: {
  provider: string;
  profile: string;
}) => {
  const existing = await Credentials.get(input).catch(() => undefined);
  if (existing) {
    log.step(
      `You are already logged in to ${pc.bold(input.provider)} on profile "${pc.bold(input.profile)}".`,
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

export const cloudflareLogin = async (scopes: string[]) => {
  const authorization = CloudflareAuth.client.authorize([
    ...scopes,
    "offline_access", // required for refresh tokens
  ]);
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
