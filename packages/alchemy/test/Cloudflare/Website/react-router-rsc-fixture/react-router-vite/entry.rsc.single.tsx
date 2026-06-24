import type * as EntrySsr from "./entry.ssr";
import { fetchServer } from "./entry.rsc";

export default async function handler(request: Request) {
  const ssr = await import.meta.viteRsc.loadModule<EntrySsr>("ssr", "index");

  return ssr.default(request, await fetchServer(request));
}
