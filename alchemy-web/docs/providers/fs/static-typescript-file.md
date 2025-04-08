# Static TypeScript File

Creates a TypeScript file with formatted content using [Prettier](https://prettier.io/). The content is automatically formatted according to TypeScript syntax rules.

# Minimal Example

Create a basic TypeScript file with formatted content.

```ts
import { StaticTypeScriptFile } from "alchemy/fs";

const file = await StaticTypeScriptFile("hello.ts", `
  function sayHello(name: string) {
    console.log("Hello " + name);
  }
`);
```

# Create with Custom Path

Create a TypeScript file specifying both path and content.

```ts
import { StaticTypeScriptFile } from "alchemy/fs";

const component = await StaticTypeScriptFile("components/Button.ts", `
  interface ButtonProps {
    text: string;
    onClick: () => void;
  }

  export function Button({ text, onClick }: ButtonProps) {
    return <button onClick={onClick}>{text}</button>;
  }
`);
```