import { createSubjects } from "@openauthjs/openauth/subject";
import type { InferOutput } from "valibot";
import { object, string } from "valibot";

export type User = InferOutput<typeof User>;

export const User = object({
  id: string(),
  name: string(),
  email: string(),
  avatar: string(),
});

export interface Subjects {
  user: InferOutput<typeof User>;
}

// Define our subject structure
export const Subjects = createSubjects({
  user: User,
});
