# Exec

The Exec resource allows you to execute shell commands as part of your Alchemy infrastructure code.

# Minimal Example

Execute a simple shell command:

```ts
import { Exec } from "alchemy/os";

const result = await Exec("list-files", {
  command: "ls -la"
});

console.log(result.stdout);
```

# Working Directory and Environment

Run a command in a specific directory with custom environment variables:

```ts
import { Exec } from "alchemy/os";

const build = await Exec("build-project", {
  command: "npm run build",
  cwd: "./my-project",
  env: { 
    NODE_ENV: "production" 
  }
});
```

# Memoized Commands

Cache command output and only re-run when the command changes:

```ts
import { Exec } from "alchemy/os";

const status = await Exec("git-status", {
  command: "git status",
  memoize: true
});

// Won't actually run again if command hasn't changed
const cached = await Exec("git-status", {
  command: "git status", 
  memoize: true
});
```

# Error Handling

Control error behavior with throwOnError:

```ts
import { Exec } from "alchemy/os";

const result = await Exec("risky-command", {
  command: "some-command-that-might-fail",
  throwOnError: true,
  maxBuffer: 10 * 1024 * 1024 // 10MB buffer
});
```