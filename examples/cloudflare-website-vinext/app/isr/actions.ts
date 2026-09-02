"use server";

import { revalidatePath } from "next/cache";

export async function refreshCachedPage() {
  revalidatePath("/isr");
}
