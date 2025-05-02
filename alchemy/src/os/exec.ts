import { spawn } from "node:child_process";
import type { Context } from "../context.js";
import { Resource } from "../resource.js";

/**
 * Properties for executing a shell command
 */
export interface ExecProps {
  /**
   * The command to execute (including any arguments)
   */
  command: string;

  /**
   * Whether to memoize the command (only re-run if the command changes)
   *
   * @default false
   */
  memoize?: boolean;

  /**
   * Working directory for the command
   */
  cwd?: string;

  /**
   * Environment variables to set
   */
  env?: Record<string, string>;

  /**
   * Whether to inherit stdio from parent process
   * @default true
   */
  inheritStdio?: boolean;
}

/**
 * Output returned after command execution
 */
export interface Exec extends Resource<"os::Exec">, ExecProps {
  /**
   * Unique identifier for this execution
   */
  id: string;

  /**
   * Exit code of the command
   */
  exitCode: number;

  /**
   * Standard output from the command (only available when inheritStdio is false)
   */
  stdout: string;

  /**
   * Standard error from the command (only available when inheritStdio is false)
   */
  stderr: string;

  /**
   * Time at which the command was executed
   */
  executedAt: number;

  /**
   * Whether the command has completed execution
   */
  completed: boolean;
}

/**
 * Execute a shell command
 *
 * @example
 * // Run a simple command with inherited stdio (default)
 * const result = await Exec("list-files", {
 *   command: "ls -la"
 * });
 *
 * @example
 * // Run a command and capture output instead of inheriting stdio
 * const result = await Exec("list-files", {
 *   command: "ls -la",
 *   inheritStdio: false
 * });
 *
 * console.log(result.stdout);
 *
 * @example
 * // Run a command in a specific directory with custom environment
 * const build = await Exec("build-project", {
 *   command: "npm run build",
 *   cwd: "./my-project",
 *   env: { NODE_ENV: "production" }
 * });
 *
 * @example
 * // Run a memoized command that only re-executes when the command changes
 * const memoizedCmd = await Exec("status-check", {
 *   command: "git status",
 *   memoize: true
 * });
 *
 * // This won't actually run the command again if nothing has changed
 * await Exec("status-check", {
 *   command: "git status",
 *   memoize: true
 * });
 */
export const Exec = Resource(
  "os::Exec",
  {
    alwaysUpdate: true,
  },
  async function (
    this: Context<Exec>,
    id: string,
    props: ExecProps,
  ): Promise<Exec> {
    if (this.phase === "delete") {
      // Nothing to actually delete for an exec command
      return this.destroy();
    }
    if (
      this.phase === "update" &&
      props.memoize &&
      this.output?.command === props.command
    ) {
      // If memoize is enabled and the command hasn't changed, return the existing output
      return this.output;
    }
    // Default values
    let stdout = "";
    let stderr = "";
    let exitCode = 0;

    // Default to inheriting stdio unless explicitly set to false
    const inheritStdio = props.inheritStdio !== false;

    try {
      // Parse the command into command and args
      const [cmd, ...args] = props.command.split(/\s+/);

      // Use spawn for better stdio control
      const childProcess = spawn(cmd, args, {
        cwd: props.cwd || process.cwd(),
        env: { ...process.env, ...props.env },
        shell: true, // Use shell to handle complex commands
        stdio: inheritStdio ? "inherit" : "pipe", // Inherit stdio when requested
      });

      if (!inheritStdio) {
        // If not inheriting stdio, collect output manually
        childProcess.stdout?.on("data", (data) => {
          stdout += data.toString();
        });

        childProcess.stderr?.on("data", (data) => {
          stderr += data.toString();
        });
      }

      // Wait for the process to complete
      exitCode = await new Promise<number>((resolve, reject) => {
        childProcess.on("close", (code) => {
          resolve(code || 0);
        });

        childProcess.on("error", (err) => {
          stderr += err.toString();
          resolve(1);
        });
      });
    } catch (error: any) {
      // If not throwing, capture the error information
      exitCode = 1;
      stderr += String(error);
    }

    if (exitCode !== 0) {
      throw new Error(
        `Command failed with exit code ${exitCode}: ${props.command}\n${stderr}`,
      );
    }

    // Return the execution result
    return this({
      id,
      command: props.command,
      cwd: props.cwd,
      env: props.env,
      memoize: props.memoize,
      inheritStdio,
      exitCode,
      stdout,
      stderr,
      executedAt: Date.now(),
      completed: true,
    });
  },
);
