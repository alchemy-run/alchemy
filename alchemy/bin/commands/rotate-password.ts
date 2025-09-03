import { log } from "@clack/prompts";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { promises as fs, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import pc from "picocolors";
import z from "zod";
import { exists } from "../../src/util/exists.ts";
import { getRunPrefix } from "../get-run-prefix.ts";
import { entrypoint, execArgs } from "../services/execute-alchemy.ts";
import { ExitSignal, loggedProcedure } from "../trpc.ts";

export const rotatePassword = loggedProcedure
  .meta({
    description: "rotate the password for an alchemy project",
  })
  .input(
    z.tuple([
      entrypoint,
      z.object({
        ...execArgs,
        oldPassword: z.string().describe("the current password"),
        newPassword: z.string().describe("the new password to set"),
        scope: z
          .string()
          .optional()
          .describe("the scope/FQN to rotate password for (optional)"),
      }),
    ]),
  )
  .mutation(async ({ input: [main, options] }) => {
    try {
      const cwd = options.cwd || process.cwd();
      let oldPassword = options.oldPassword;
      let newPassword = options.newPassword;

      // Validate passwords
      if (oldPassword === newPassword) {
        log.error(pc.red("New password must be different from old password"));
        throw new ExitSignal(1);
      }

      // Check for alchemy.run.ts or alchemy.run.js (if not provided)
      let alchemyFile = main;
      if (!alchemyFile) {
        const candidates = ["alchemy.run.ts", "alchemy.run.js"];
        for (const file of candidates) {
          const resolved = resolve(cwd, file);
          if (await exists(resolved)) {
            alchemyFile = resolved;
            break;
          }
        }
      }

      if (!alchemyFile) {
        log.error(
          pc.red(
            "No alchemy.run.ts or alchemy.run.js file found in the current directory.",
          ),
        );
        throw new ExitSignal(1);
      }

      // Create a wrapper script that will load the alchemy file and call rotatePassword
      const wrapperScript = `
			${await fs.readFile(alchemyFile, "utf8")}

			// =================
			
  const { rotatePassword: __ALCHEMY_ROTATE_PASSWORD } = await import("alchemy");
  const __ALCHEMY_oldPassword = "${oldPassword.replace(/"/g, '\\"')}";
  const __ALCHEMY_newPassword = "${newPassword.replace(/"/g, '\\"')}";
  const __ALCHEMY_scope = ${options.scope ? `"${options.scope.replace(/"/g, '\\"')}"` : "undefined"};
  
  try {
    await __ALCHEMY_ROTATE_PASSWORD(__ALCHEMY_oldPassword, __ALCHEMY_newPassword, __ALCHEMY_scope);
    console.log("\\n✅ Password rotation completed successfully");
    process.exit(0);
  } catch (error) {
    console.error("\\n❌ Password rotation failed:", error.message);
    process.exit(1);
  }
`;

      // Write the wrapper script to a temporary file
      const tempScriptPath = resolve(
        cwd,
        `.alchemy-rotate-${Date.now()}.${alchemyFile.endsWith(".ts") ? "ts" : "mjs"}`,
      );
      writeFileSync(tempScriptPath, wrapperScript);

      try {
        const runPrefix = await getRunPrefix({
          isTypeScript: tempScriptPath.endsWith(".ts"),
          cwd,
        });
        let command = `${runPrefix} ${tempScriptPath}`;

        // Set the old password in environment for the alchemy scope to use
        const env = {
          ...process.env,
          ALCHEMY_PASSWORD: oldPassword,
          FORCE_COLOR: "1",
        } as Record<string, string>;

        // Handle stage if provided
        if (options.stage) {
          env.STAGE = options.stage;
        }

        // Load env file if specified
        if (options.envFile && (await exists(resolve(cwd, options.envFile)))) {
          // The subprocess will handle loading the env file
          command = `${command} --env-file ${options.envFile}`;
        }

        const child = spawn(command, {
          cwd,
          shell: true,
          stdio: "inherit",
          env,
        });

        const exitPromise = once(child, "exit");
        await exitPromise;

        const exitCode = child.exitCode === 1 ? 1 : 0;

        // Clean up temp file
        unlinkSync(tempScriptPath);

        if (exitCode !== 0) {
          throw new ExitSignal(exitCode);
        }
      } catch (error) {
        // Clean up temp file on error
        try {
          unlinkSync(tempScriptPath);
        } catch {}
        throw error;
      }
    } catch (error) {
      if (error instanceof ExitSignal) {
        throw error;
      }
      if (error instanceof Error) {
        log.error(`${pc.red("Error:")} ${error.message}`);
        if (error.stack && process.env.DEBUG) {
          log.error(`${pc.gray("Stack trace:")}\n${error.stack}`);
        }
      } else {
        log.error(pc.red(String(error)));
      }
      throw new ExitSignal(1);
    }
  });
