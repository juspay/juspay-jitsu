import { afterEach, describe, expect, test } from "vitest";
import { getFunctionsServerUrl } from "../src/lib/functions-server-client";
import { resetServerEnvCache } from "../src/serverEnv";

const originalTemplate = process.env.FUNCTIONS_SERVER_URL_TEMPLATE;
const originalFallback = process.env.FUNCTIONS_SERVER_FALLBACK_URL;

afterEach(() => {
  if (originalTemplate === undefined) {
    delete process.env.FUNCTIONS_SERVER_URL_TEMPLATE;
  } else {
    process.env.FUNCTIONS_SERVER_URL_TEMPLATE = originalTemplate;
  }
  if (originalFallback === undefined) {
    delete process.env.FUNCTIONS_SERVER_FALLBACK_URL;
  } else {
    process.env.FUNCTIONS_SERVER_FALLBACK_URL = originalFallback;
  }
  resetServerEnvCache();
});

describe("getFunctionsServerUrl", () => {
  test("uses the fixed fallback for an operatorless deployment", () => {
    process.env.FUNCTIONS_SERVER_FALLBACK_URL = "http://jitsu-functions.test/";
    resetServerEnvCache();

    expect(getFunctionsServerUrl("operatorless", "connection-1")).toBe(
      "http://jitsu-functions.test/connection/connection-1"
    );
  });

  test("continues to use the workspace template for Operator-managed deployments", () => {
    process.env.FUNCTIONS_SERVER_URL_TEMPLATE = "http://fs-${workspaceId}:3456";
    process.env.FUNCTIONS_SERVER_FALLBACK_URL = "http://jitsu-functions.test";
    resetServerEnvCache();

    expect(getFunctionsServerUrl("deployment-1", "connection-1")).toBe(
      "http://fs-deployment-1:3456/connection/connection-1"
    );
  });
});
