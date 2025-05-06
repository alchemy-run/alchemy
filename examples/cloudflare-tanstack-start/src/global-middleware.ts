import { registerGlobalMiddleware } from "@tanstack/react-start";
import { logMiddleware } from "./utils/loggingMiddleware.js";

registerGlobalMiddleware({
  middleware: [logMiddleware],
});
