# Domain + yielded auth

Signs users in to a Domain Api with [yielded auth](https://yielded.dev/auth/). Companion to the [Sign in with yielded](https://alchemy.run/domain/yielded-auth) page.

The `Session` middleware reads yielded's session cookie and checks it with `auth.verifySession`, then provides `CurrentUser` to commands and views. `src/Auth.ts` declares GitHub and Google sign-in; yielded's [OAuth guide](https://yielded.dev/auth/guide/oauth/) covers the storage, keys and provider setup it needs.

```sh
pnpm install
pnpm test
```

The tests sign users in with real yielded sessions and call the Api in process.
