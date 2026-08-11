import { NextRouter } from "next/router";
import { withBasePath, withoutBasePath } from "./base-path";

const authPaths = ["/signin", "/signup", "/reset-password"];

function isAuthPath(path: string): boolean {
  return authPaths.some(authPath => path.startsWith(authPath) || path.startsWith(withBasePath(authPath)));
}

/**
 * Utility functions for handling return URLs during authentication flows
 */

/**
 * Captures the current URL and returns it as a callback URL for authentication
 * @param router Next.js router instance
 * @returns callback URL to redirect to after authentication
 */
export function captureReturnUrl(router: NextRouter): string {
  // Don't redirect back to auth-related pages
  const currentPath = withBasePath(router.asPath);

  if (isAuthPath(currentPath)) {
    return withBasePath("/"); // Redirect to home if on auth page
  }

  // Use the full current path including query parameters
  return currentPath;
}

/**
 * Extracts return URL from various sources (query params, headers, etc.)
 * @param req Next.js API request
 * @returns return URL or null if none found
 */
export function extractReturnUrl(req: any): string | null {
  // Check for explicit callbackUrl parameter
  if (req.query?.callbackUrl) {
    return req.query.callbackUrl as string;
  }
  return null;
}

/**
 * Validates and sanitizes a return URL
 * we do not allow absolute URLs to prevent open redirects
 * @param returnUrl URL to validate
 * @returns sanitized URL or null if invalid
 */
export function validateReturnUrl(returnUrl: string): string | undefined {
  if (!returnUrl) {
    return;
  }

  // Allow relative URLs
  if (returnUrl.startsWith("/") && !returnUrl.startsWith("//")) {
    // Ensure it's not an auth page
    if (isAuthPath(returnUrl)) {
      return withBasePath("/");
    }
    return returnUrl;
  }
}

/**
 * Performs a safe redirect to the return URL
 * @param router Next.js router instance
 * @param returnUrl URL to redirect to
 */
export function safeRedirect(router: NextRouter, returnUrl: string | null): void {
  const validatedUrl = validateReturnUrl(returnUrl || withBasePath("/"));
  const finalUrl = withBasePath(validatedUrl || "/");

  console.log(`Redirecting to: ${finalUrl}`);

  // Next Router adds its configured basePath automatically, so pass it an
  // unprefixed path even though callback URLs themselves must include it.
  router.push(withoutBasePath(finalUrl));
}

/**
 * Adds return URL parameter to a signin URL
 * @param signinUrl Base signin URL
 * @param returnUrl Return URL to preserve
 * @returns signin URL with return URL parameter
 */
export function addReturnUrlToSignin(signinUrl: string, returnUrl: string | null): string {
  const basePathSigninUrl = withBasePath(signinUrl);
  if (!returnUrl) {
    return basePathSigninUrl;
  }

  const validatedUrl = validateReturnUrl(returnUrl);
  if (!validatedUrl || validatedUrl === "/") {
    return basePathSigninUrl;
  }

  const url = new URL(basePathSigninUrl, window.location.origin);
  url.searchParams.set("callbackUrl", validatedUrl);
  return url.toString();
}
