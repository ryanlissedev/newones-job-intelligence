/**
 * Shared test entry for the fixture suite. The browser reaches the auth stub
 * directly on 127.0.0.1 (NEXT_PUBLIC_SERVER_URL), so the suite needs a local
 * Chromium that shares the runner's loopback. A runner-side auth proxy was
 * removed: it was never activated (no test requested the fixture), and a
 * remote browser lane is not supported by this suite.
 */
export { test } from "@e2e-dev/web";
