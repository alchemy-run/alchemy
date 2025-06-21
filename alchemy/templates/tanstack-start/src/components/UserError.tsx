import {
  ErrorComponent,
  type ErrorComponentProps,
} from "@tanstack/react-router";

export function UserErrorComponent({ error }: ErrorComponentProps) {
  return <ErrorComponent error={error} />;
}
