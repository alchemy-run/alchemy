import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Context } from "../context.js";
import { Resource } from "../resource.js";

const execAsync = promisify(exec);

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
   * Maximum buffer size for stdout and stderr (in bytes)
   * @default 1024 * 1024 (1MB)
   */
  maxBuffer?: number;

  /**
   * Whether to throw an error if the command exits with a non-zero status
   */
  throwOnError?: boolean;
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
   * Standard output from the command
   */
  stdout: string;

  /**
   * Standard error from the command
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
 * // Run a simple command
 * const result = await Exec("list-files", {
 *   command: "ls -la"
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
 * // Run a command with a larger buffer for output
 * const logs = await Exec("get-logs", {
 *   command: "cat large-log-file.log",
 *   maxBuffer: 10 * 1024 * 1024 // 10MB
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
    props: ExecProps
  ): Promise<Exec> {
    if (this.phase === "delete") {
      // Nothing to actually delete for an exec command
      return this.destroy();
    } else if (
      this.phase === "update" &&
      props.memoize &&
      this.output?.command === props.command
    ) {
      // If memoize is enabled and the command hasn't changed, return the existing output
      return this.output;
    } else {
      // Default values
      let stdout = "";
      let stderr = "";
      let exitCode = 0;

      try {
        console.log(props.command);
        // Execute the command
        const result = await execAsync(props.command, {
          cwd: props.cwd || process.cwd(),
          env: { ...process.env, ...props.env },
          maxBuffer: props.maxBuffer || 1024 * 1024, // Default 1MB
        });

        stdout = result.stdout;
        console.log(stdout);
        stderr = result.stderr;
        exitCode = 0; // Success
      } catch (error: any) {
        console.log("error", error);
        if (props.throwOnError) {
          throw error;
        }

        // If not throwing, capture the error information
        exitCode = error.code || 1;
        stdout = error.stdout || "";
        stderr = error.stderr || String(error);
        console.log(stdout);
        console.error(stderr);
      }

      // Return the execution result
      return this({
        id,
        command: props.command,
        cwd: props.cwd,
        env: props.env,
        maxBuffer: props.maxBuffer,
        throwOnError: props.throwOnError,
        memoize: props.memoize,
        exitCode,
        stdout,
        stderr,
        executedAt: Date.now(),
        completed: true,
      });
    }
  }
);
