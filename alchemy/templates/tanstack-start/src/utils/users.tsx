export type User = {
  id: number;
  name: string;
  email: string;
};

// must check if window is not undefined since the bundler also places this code server-side
export const DEPLOY_URL =
  typeof window !== "undefined"
    ? window.location.origin
    : "http://localhost:3000";
