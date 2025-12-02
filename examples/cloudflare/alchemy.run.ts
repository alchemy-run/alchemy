import { $stage, defineStack, Stack } from "alchemy-effect";
import * as Cloudflare from "alchemy-effect/cloudflare/live";
import * as Effect from "effect/Effect";
import { Api } from "./src/api.ts";

const cloudflare = {
  account: import.meta.env.CLOUDFLARE_ACCOUNT_ID!,
};

const name = "my-cloudflare-app";

export type App = typeof App;
export const App = defineStack({
  name,
  resources: [Api],
  providers: Cloudflare.live(cloudflare),
}).pipe(Effect.tap((stack) => Effect.log(stack?.Api.url)));

const ref = (stage: string = $stage, suffix?: string) =>
  Stack.ref<App>({
    name,
    parent: suffix ? stage : undefined,
    stage: suffix ? `${stage}-${suffix}` : stage,
    cloudflare,
  });

export const prod = ref("prod");
export const staging = (pr?: number) => ref("staging", pr?.toString());
export const dev = (user: string = import.meta.env.USER!) => ref("dev", user);
