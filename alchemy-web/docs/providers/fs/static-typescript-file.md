# StaticTypeScriptFile

Creates a TypeScript file with automatic formatting using [Prettier](https://prettier.io/).

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

# Create File with Custom Path

Creates a TypeScript file at a specific path.

```ts
import { StaticTypeScriptFile } from "alchemy/fs";

const component = await StaticTypeScriptFile("components/Button.ts", 
  `interface Props {
    text: string;
    onClick: () => void;
  }

  export function Button({text, onClick}: Props) {
    return <button onClick={onClick}>{text}</button>;
  }`
);
```