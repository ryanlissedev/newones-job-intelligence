export const stripTrailingSlash = (url: string): string =>
  url.endsWith("/") ? url.slice(0, -1) : url;
