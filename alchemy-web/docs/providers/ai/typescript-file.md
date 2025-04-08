# TypeScriptFile

The TypeScriptFile resource lets you generate [TypeScript](https://www.typescriptlang.org/) files using AI models.

# Minimal Example

Creates a basic TypeScript utility file.

```ts
import { TypeScriptFile } from "alchemy/ai";

const utils = await TypeScriptFile("string-utils", {
  path: "./src/utils/string-utils.ts",
  prompt: "Generate TypeScript utility functions for string manipulation"
});
```

# Create a TypeScript Component

Generates a TypeScript React component with proper typing.

```ts
import { TypeScriptFile } from "alchemy/ai";

const component = await TypeScriptFile("user-card", {
  path: "./src/components/UserCard.tsx",
  prompt: await alchemy`
    Create a React component that displays user information.
    Use the types from:
    ${alchemy.file("src/types/User.ts")}
  `,
  temperature: 0.2,
  prettierConfig: {
    semi: false,
    singleQuote: true
  }
});
```