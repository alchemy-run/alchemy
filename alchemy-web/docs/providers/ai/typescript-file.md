# TypeScript File

The TypeScript File resource allows you to generate and manage TypeScript files using AI models. It leverages AI to create TypeScript code based on user-defined prompts and formats the code using Prettier. Learn more about [TypeScript](https://www.typescriptlang.org/).

# Minimal Example

```ts
import { TypeScriptFile } from "alchemy/ai";

const utils = await TypeScriptFile("string-utils", {
  path: "./src/utils/string-utils.ts",
  prompt: "Generate TypeScript utility functions for string manipulation.",
});
```

# Create the TypeScript File

```ts
import { TypeScriptFile } from "alchemy/ai";

const userService = await TypeScriptFile("user-service", {
  path: "./src/services/UserService.ts",
  prompt: `
    Create a UserService class that handles user authentication and profile management.
    Include methods for login, register, updateProfile, and deleteAccount.
  `,
  temperature: 0.2,
  prettierConfig: {
    semi: false,
    singleQuote: true,
    printWidth: 120,
  },
});
```