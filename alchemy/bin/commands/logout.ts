import { confirm, intro, log, outro } from "@clack/prompts";
import pc from "picocolors";
import z from "zod";
import { Credentials, Provider } from "../../src/auth.ts";
import { CloudflareAuth } from "../../src/cloudflare/auth.ts";
import { authProcedure, CancelSignal } from "../trpc.ts";

export const logout = authProcedure
  .meta({
    description: "logout from a provider",
  })
  .input(
    z.object({
      provider: z
        .enum(["cloudflare"])
        .default("cloudflare")
        .meta({ positional: true })
        .describe("the provider to logout from"),
      profile: z
        .string()
        .default("default")
        .meta({ alias: "p" })
        .describe("the profile to logout from"),
      yes: z
        .boolean()
        .default(false)
        .meta({ alias: "y" })
        .describe("skip confirmation"),
    }),
  )
  .mutation(async ({ input }) => {
    intro(pc.cyan("🧪 Logout"));
    const provider = await Provider.get<CloudflareAuth.Metadata>(input);
    const credentials = await Credentials.get(input);
    if (!credentials) {
      outro(
        pc.red(
          `❌ Not logged in to ${input.provider} on profile "${input.profile}".`,
        ),
      );
      return;
    }
    log.step(
      [
        `Logging out from provider ${input.provider} on profile "${input.profile}"`,
        ...(provider
          ? [`Account: ${provider.metadata.name} (${provider.metadata.id})`]
          : []),
        `Credentials: ${credentials.type}`,
      ].join("\n"),
    );
    if (!input.yes) {
      const overwrite = await confirm({
        message: "Continue?",
        initialValue: false,
      });
      if (overwrite !== true) {
        throw new CancelSignal();
      }
    }
    if (credentials.type === "oauth") {
      await CloudflareAuth.client.revoke(credentials);
    }
    await Credentials.del(input);
    outro(`✅ Signed out from ${pc.bold(input.provider)}.`);
  });
