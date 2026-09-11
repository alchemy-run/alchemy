"use server";

import { revalidateTag } from "next/cache";

export async function refreshCachedStamp() {
  revalidateTag("demo-stamp", "max");
}
