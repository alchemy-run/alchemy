# Static TypeScript File

The Static TypeScript File resource creates a TypeScript file with formatted content using [Prettier](https://prettier.io/).

# Minimal Example

Creates a basic TypeScript file with formatted content.

```ts
import { StaticTypeScriptFile } from "alchemy/fs";

const file = await StaticTypeScriptFile("Component.ts", `
  interface Props {
    name: string;
    age: number;
  }

  export function Component({ name, age }: Props) {
    return <div>Hello {name}, you are {age} years old</div>;
  }
`);
```

# Create a TypeScript Interface File

```ts
import { StaticTypeScriptFile } from "alchemy/fs";

const interfaces = await StaticTypeScriptFile("types.ts", `
  export interface User {
    id: string;
    name: string;
    email: string;
    createdAt: Date;
  }

  export interface Post {
    id: string;
    title: string;
    content: string;
    authorId: string;
    publishedAt?: Date;
  }
`);
```

# Create a React Component File

```ts
import { StaticTypeScriptFile } from "alchemy/fs";

const component = await StaticTypeScriptFile("UserProfile.tsx", `
  import React from 'react';
  import type { User } from './types';

  interface Props {
    user: User;
    onUpdate: (user: User) => void;
  }

  export function UserProfile({ user, onUpdate }: Props) {
    return (
      <div className="profile">
        <h1>{user.name}</h1>
        <p>{user.email}</p>
        <span>Member since {user.createdAt.toLocaleDateString()}</span>
      </div>
    );
  }
`);
```