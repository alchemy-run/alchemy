# Static TypeScript File

The Static TypeScript File resource creates formatted TypeScript files using [Prettier](https://prettier.io/) for consistent code style.

# Minimal Example

Creates a basic TypeScript file with automatic formatting.

```ts
import { StaticTypeScriptFile } from "alchemy/fs";

const file = await StaticTypeScriptFile("hello.ts", `
  export function hello(name: string) {
    return "Hello " + name;
  }
`);
```

# Create Component File

```ts
import { StaticTypeScriptFile } from "alchemy/fs";

const component = await StaticTypeScriptFile("Component.ts", `
  interface Props {
    name: string;
    age: number;
  }

  export function Component({ name, age }: Props) {
    return <div>Hello {name}, you are {age} years old</div>;
  }
`);
```

# Create with Custom Path

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