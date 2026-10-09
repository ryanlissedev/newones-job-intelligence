/**
 * What /jobs may show for the current session. "checking" covers the server
 * render, the first client render and the in-flight session request: nothing
 * session-dependent is decided there, so the server HTML and hydration agree
 * and no protected data (or data request) exists before the session is known.
 */
export type JobsAccess =
  | "anonymous"
  | "authenticated"
  | "checking"
  | "fixtures";

export const resolveJobsAccess = ({
  fixtures,
  isPending,
  mounted,
  userId,
}: {
  readonly fixtures: boolean;
  readonly isPending: boolean;
  readonly mounted: boolean;
  readonly userId: string | undefined;
}): JobsAccess => {
  if (fixtures) {
    return "fixtures";
  }
  if (!mounted || isPending) {
    return "checking";
  }
  return userId ? "authenticated" : "anonymous";
};
