# StaticTypeScriptFile

Creates a TypeScript file with automatic formatting using [Prettier](https://prettier.io/). The file content will be formatted according to TypeScript syntax rules.

## Minimal Example

Create a basic TypeScript file with formatted content.

```ts
import { StaticTypeScriptFile } from "alchemy/fs";

const file = await StaticTypeScriptFile("hello.ts", `
  function sayHello(name: string): string {
    return "Hello " + name;
  }
`);
```

## Create Component File

Create a TypeScript React component with proper formatting.

```ts
import { StaticTypeScriptFile } from "alchemy/fs";

const component = await StaticTypeScriptFile("Button.tsx", `
  interface ButtonProps {
    text: string;
    onClick: () => void;
  }

  export function Button({ text, onClick }: ButtonProps) {
    return (
      <button onClick={onClick}>
        {text}
      </button>
    );
  }
`);
```

## Create with Custom Path

Create a TypeScript file at a specific path location.

```ts
import { StaticTypeScriptFile } from "alchemy/fs";

const utils = await StaticTypeScriptFile("utils", 
  "src/utils/format.ts",
  `
  export function formatDate(date: Date): string {
    return date.toLocaleDateString();
  }
  
  export function formatCurrency(amount: number): string {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD'
    }).format(amount);
  }
  `
);
```