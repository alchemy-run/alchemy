import api from "../snippets/api.ts?raw";
import jobs from "../snippets/jobs.ts?raw";
import jobServiceDynamo from "../snippets/JobServiceDynamo.ts?raw";
import jobServiceKV from "../snippets/JobServiceKV.ts?raw";
import plainApi from "../snippets/plain-api.ts?raw";
import plain from "../snippets/plain.ts?raw";
import stack from "../snippets/stack.ts?raw";
import { cut } from "./snippet.ts";

/** The code on screen, cut from the type-checked files in snippets/. */
export const code = {
  api: cut(api),
  jobs: cut(jobs),
  plain: cut(plain),
  plainApi: cut(plainApi),
  stack: cut(stack),
  jobServiceKV: cut(jobServiceKV),
  jobServiceDynamo: cut(jobServiceDynamo),
};
