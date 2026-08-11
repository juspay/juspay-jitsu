import { clientBasePath } from "./shared/clientEnv";

/**
 * Prefix a same-origin absolute path with the console's build-time base path.
 * External, protocol-relative, and already-prefixed URLs are left unchanged.
 */
export function applyBasePath(url: string, basePath: string): string {
  if (!basePath || !url.startsWith("/") || url.startsWith("//")) {
    return url;
  }
  if (url === basePath || url.startsWith(`${basePath}/`) || url.startsWith(`${basePath}?`)) {
    return url;
  }
  return `${basePath}${url}`;
}

export function removeBasePath(url: string, basePath: string): string {
  if (!basePath) {
    return url;
  }
  if (url === basePath) {
    return "/";
  }
  if (url.startsWith(`${basePath}/`)) {
    return url.slice(basePath.length);
  }
  if (url.startsWith(`${basePath}?`) || url.startsWith(`${basePath}#`)) {
    return `/${url.slice(basePath.length)}`;
  }
  return url;
}

export function withBasePath(url: string): string {
  return applyBasePath(url, clientBasePath);
}

export function withoutBasePath(url: string): string {
  return removeBasePath(url, clientBasePath);
}

export const basePathFetch: typeof fetch = (input, init) => {
  return fetch(typeof input === "string" ? withBasePath(input) : input, init);
};
