import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cleanupTestConfigs, startTestFunctionsServer, TestFunctionsServer } from "./functions-server-helper";

const connectionId = "remote-connection";
const functionId = "remote-function";
const profileBuilderId = "remote-profile-builder";
const repositoryToken = "test-repository-token";
const configDir = path.join(os.tmpdir(), `functions-server-remote-${Date.now()}`);

let repositoryRevision = 1;
let functionVersion = 1;
let profileBuilderVersion = 1;
let invalidProfileCode = false;
let repositoryServer: http.Server;
let repositoryBaseUrl: string;
let functionsServer: TestFunctionsServer;
const denoAvailable = spawnSync("deno", ["--version"], { stdio: "ignore" }).status === 0;

function currentLastModified(): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, repositoryRevision)).toUTCString();
}

function repositoryPayload(pathname: string): unknown[] {
  if (pathname === "/rotor-connections") {
    return [
      {
        id: connectionId,
        workspaceId: "remote-workspace",
        updatedAt: currentLastModified(),
        destinationId: "destination-1",
        streamId: "stream-1",
        metricsKeyPrefix: "remote",
        usesBulker: false,
        type: "webhook",
        optionsHash: `options-v${functionVersion}`,
        credentialsHash: "credentials-v1",
        credentials: {},
        options: { functions: [{ functionId: `udf.${functionId}` }] },
      },
    ];
  }
  if (pathname === "/functions") {
    return [
      {
        id: functionId,
        workspaceId: "remote-workspace",
        name: "Remote function",
        createdAt: currentLastModified(),
        updatedAt: currentLastModified(),
        codeHash: `code-v${functionVersion}`,
        code: `export default async function(event) {
          event.properties.remoteVersion = ${functionVersion};
          return event;
        }`,
      },
    ];
  }
  if (pathname === "/workspaces-with-profiles") {
    return [
      {
        id: "remote-workspace",
        name: "Remote workspace",
        slug: "remote-workspace",
        createdAt: currentLastModified(),
        updatedAt: currentLastModified(),
        featuresEnabled: [],
        profileBuilders: [
          {
            id: profileBuilderId,
            workspaceId: "remote-workspace",
            createdAt: currentLastModified(),
            updatedAt: currentLastModified(),
            version: profileBuilderVersion,
            destinationId: "destination-1",
            intermediateStorageCredentials: {},
            connectionOptions: {},
            functions: [
              {
                id: "profile-function",
                workspaceId: "remote-workspace",
                name: "Remote profile function",
                createdAt: currentLastModified(),
                updatedAt: currentLastModified(),
                codeHash: `profile-code-v${profileBuilderVersion}`,
                code: invalidProfileCode
                  ? "export default async function( {"
                  : `export default async function(events, user) {
                      return { profileId: user.profileId, traits: { remoteVersion: ${profileBuilderVersion} } };
                    }`,
              },
            ],
          },
        ],
      },
    ];
  }
  return [];
}

async function executeFunction(): Promise<number | undefined> {
  const response = await fetch(`${functionsServer.baseUrl}/connection/${connectionId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event: { type: "track", properties: {} },
      context: { receivedAt: new Date().toISOString() },
    }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { events: Array<{ properties?: { remoteVersion?: number } }> };
  return body.events[0]?.properties?.remoteVersion;
}

async function loadProfileBuilder(): Promise<number | undefined> {
  await fetch(`${functionsServer.baseUrl}/profile/${profileBuilderId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profileId: "user-1" }),
  });
  const health = (await fetch(`${functionsServer.baseUrl}/health`).then(res => res.json())) as {
    profileBuilderVersions?: Record<string, number>;
  };
  return health.profileBuilderVersions?.[profileBuilderId];
}

describe.skipIf(!denoAvailable)("Functions Server remote config", () => {
  beforeAll(async () => {
    repositoryServer = http.createServer((req, res) => {
      if (req.headers.authorization !== `Bearer ${repositoryToken}`) {
        res.writeHead(401).end("unauthorized");
        return;
      }
      const pathname = new URL(req.url || "/", "http://repository.test").pathname;
      if (req.headers["if-modified-since"] === currentLastModified()) {
        res.writeHead(304).end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Last-Modified": currentLastModified(),
      });
      res.end(JSON.stringify(repositoryPayload(pathname)));
    });
    await new Promise<void>(resolve => repositoryServer.listen(0, "127.0.0.1", resolve));
    const address = repositoryServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Repository test server did not expose a TCP port");
    }
    repositoryBaseUrl = `http://127.0.0.1:${address.port}`;

    functionsServer = await startTestFunctionsServer(configDir, 3657, {
      FUNCTIONS_CLASS: "dedicated",
      FUNCTIONS_SERVER_REMOTE_CONFIG: "true",
      REPOSITORY_BASE_URL: repositoryBaseUrl,
      REPOSITORY_AUTH_TOKEN: repositoryToken,
      REPOSITORY_REFRESH_PERIOD_SEC: "1",
      MONGODB_URL: "",
      SHUTDOWN_EXTRA_DELAY_SEC: "0",
    });
  }, 60000);

  afterAll(async () => {
    await functionsServer?.close();
    await new Promise<void>(resolve => repositoryServer?.close(() => resolve()));
    cleanupTestConfigs(configDir);
  });

  test("atomically hot-reloads changed functions and Profile Builders without restarting", async () => {
    expect(await executeFunction()).toBe(1);
    expect(await loadProfileBuilder()).toBe(1);

    functionVersion = 2;
    profileBuilderVersion = 2;
    repositoryRevision = 2;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if ((await executeFunction()) === 2 && (await loadProfileBuilder()) === 2) {
        invalidProfileCode = true;
        profileBuilderVersion = 3;
        repositoryRevision = 3;
        await new Promise(resolve => setTimeout(resolve, 1250));
        expect(await loadProfileBuilder()).toBe(2);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error("Functions Server did not activate repository version 2 within 10 seconds");
  });
});
