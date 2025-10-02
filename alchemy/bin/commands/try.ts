import { intro, isCancel, outro, password, text } from "@clack/prompts";
import pc from "picocolors";
import z from "zod";
import { Credentials, Profile } from "../../src/auth.ts";
import { authProcedure, CancelSignal } from "../trpc.ts";

export const tryCommand = authProcedure
  .meta({
    description: "try command for testing",
  })
  .input(
    z.object({
      id: z.string().describe("the id to use"),
      profile: z
        .string()
        .optional()
        .meta({ alias: "p" })
        .describe("the profile name"),
    }),
  )
  .mutation(async ({ input }) => {
    intro(pc.cyan("🧪 Try Command"));

    // Get or prompt for profile name
    let profileName = input.profile?.trim();
    if (!profileName) {
      const name = await text({
        message: "Enter profile name",
        defaultValue: "default",
        placeholder: "default",
      });
      if (isCancel(name)) {
        throw new CancelSignal();
      }
      profileName = name.trim() || "default";
    }

    // Get the profile
    const profile = await Profile.get(profileName);

    // Prompt for password
    const pwd = await password({
      message: "Enter password",
    });
    if (isCancel(pwd)) {
      throw new CancelSignal();
    }

    // Get all credential files for the profile
    const credentialFiles: Array<{ filename: string; content: string }> = [];
    if (profile) {
      const providers = Object.keys(profile);
      for (const provider of providers) {
        try {
          const credentials = await Credentials.get({
            profile: profileName,
            provider,
          });
          if (credentials) {
            credentialFiles.push({
              filename: `${provider}.json`,
              content: JSON.stringify(credentials, null, 2),
            });
          }
        } catch {}
      }
    }

    const data = {
      profile: profile,
      password: pwd,
      credentialFiles,
    };

    const res = await fetch(
      `http://localhost:1337/project/${input.id}/configure`,
      {
        method: "POST",
        body: JSON.stringify(data),
      },
    );

    outro(pc.green("✅ Done"));
  });
