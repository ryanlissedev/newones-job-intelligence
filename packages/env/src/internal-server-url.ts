/**
 * The web app talks to the API from two places that do not share a network
 * view. The browser reaches it through NEXT_PUBLIC_SERVER_URL (a public URL,
 * inlined into the client bundle at build time). Server Components and route
 * handlers run inside the web container, where that public URL is often not
 * routable — in Compose it is http://localhost:3000, which resolves to the web
 * container itself. INTERNAL_SERVER_URL names the address the *server process*
 * must use instead (http://server:3000 in Compose, the internal service URL in
 * Coolify). Plain local dev has one URL for both, so it may stay unset.
 */
export interface ServerUrlSource {
  readonly INTERNAL_SERVER_URL?: string | undefined;
  readonly NEXT_PUBLIC_SERVER_URL: string;
}

export const resolveInternalServerUrl = (source: ServerUrlSource): string => {
  const internal = source.INTERNAL_SERVER_URL;
  if (internal === undefined || internal === "") {
    return source.NEXT_PUBLIC_SERVER_URL;
  }
  return internal;
};
