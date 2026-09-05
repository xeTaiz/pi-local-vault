import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";

import localVault from "./index.js";

type RegisteredTool = {
  name: string;
  description: string;
  loadMode?: string;
  parameters: {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  execute: (
    toolCallId: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<unknown>;
};

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const environmentKeys = ["WH_SESSION_ROLE", "LOCAL_VAULT_READONLY", "LOCAL_VAULT_URL", "LOCAL_VAULT_TOKEN_FILE", "LOCAL_VAULT_TAILNET_DNS_SUFFIX"];
const originalEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
beforeEach(() => {
  delete process.env.WH_SESSION_ROLE;
  delete process.env.LOCAL_VAULT_READONLY;
});
afterEach(() => {
  for (const key of environmentKeys) restoreEnv(key, originalEnvironment[key]);
});

test("registers the minimal Pi and OMP tool contract", () => {
  const tools = new Map<string, RegisteredTool>();
  localVault({
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
  } as never);

  assert.deepEqual([...tools.keys()], [
    "vault_read",
    "vault_get",
    "vault_job_status",
    "vault_update",
    "vault_research",
  ]);
  assert.equal(tools.get("vault_status"), undefined);

  const read = tools.get("vault_read");
  assert.ok(read);
  assert.equal(read.loadMode, "essential");
  assert.deepEqual(
    Object.keys(read.parameters.properties ?? {}).sort(),
    ["question", "searchBudget"],
  );

  const update = tools.get("vault_update");
  assert.ok(update);
  assert.equal(update.loadMode, "essential");
  assert.ok(update.parameters.required?.includes("context"));

  const jobStatus = tools.get("vault_job_status");
  assert.ok(jobStatus);
  assert.equal(jobStatus.loadMode, undefined);
  const research = tools.get("vault_research");
  assert.ok(research);
  assert.ok("idempotencyKey" in (research.parameters.properties ?? {}));
});

test("task role cannot register writes even without the launcher read-only flag", () => {
  process.env.WH_SESSION_ROLE = "task";
  process.env.LOCAL_VAULT_READONLY = "0";
  const names: string[] = [];
  localVault({ registerTool: (tool: RegisteredTool) => names.push(tool.name) } as never);
  assert.deepEqual(names, ["vault_read", "vault_get", "vault_job_status"]);
});

test("explicit read-only mode removes writes for an otherwise writable PM", () => {
  process.env.WH_SESSION_ROLE = "pm";
  process.env.LOCAL_VAULT_READONLY = "1";
  const names: string[] = [];
  localVault({ registerTool: (tool: RegisteredTool) => names.push(tool.name) } as never);
  assert.deepEqual(names, ["vault_read", "vault_get", "vault_job_status"]);
});

test("sends exact read, get, and update requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-local-vault-"));
  const tokenFile = join(directory, "token");
  await writeFile(tokenFile, "test-token\n", "utf8");
  process.env.LOCAL_VAULT_URL = "http://127.0.0.1:8088";
  process.env.LOCAL_VAULT_TOKEN_FILE = tokenFile;

  const tools = new Map<string, RegisteredTool>();
  localVault({
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
  } as never);

  const requests: Array<{ url: string; init: RequestInit; body: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, init: init ?? {}, body });
    if (url.endsWith("/v1/updates")) {
      return new Response(JSON.stringify({ error: "compat" }), { status: 404 });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    await tools.get("vault_read")?.execute("read", {
      question: "q",
      searchBudget: "default",
    });
    await tools.get("vault_get")?.execute("get", {
      retrievalId: "11111111-1111-4111-8111-111111111111",
      nodeId: "N001",
    });
    await tools.get("vault_update")?.execute("update", {
      instruction: "durable",
      context: "self-contained evidence",
    });
    await tools.get("vault_research")?.execute("research", {
      topic: "Research https://arxiv.org/abs/2601.00001",
      idempotencyKey: "scholar-inbox.abc123",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(requests.map((request) => request.url), [
    "http://127.0.0.1:8088/v1/read",
    "http://127.0.0.1:8088/v1/get",
    "http://127.0.0.1:8088/v1/updates",
    "http://127.0.0.1:8088/v1/update",
    "http://127.0.0.1:8088/v1/research",
  ]);
  assert.deepEqual(requests[0].body, {
    query: "q",
    searchBudget: "default",
  });
  assert.deepEqual(requests[1].body, {
    retrievalId: "11111111-1111-4111-8111-111111111111",
    nodeId: "N001",
  });
  assert.deepEqual(requests[2].body, {
    instruction: "durable",
    context: "self-contained evidence",
  });
  assert.deepEqual(requests[3].body, requests[2].body);
  assert.deepEqual(requests[4].body, {
    topic: "Research https://arxiv.org/abs/2601.00001",
  });
  assert.equal(
    new Headers(requests[4].init.headers).get("x-idempotency-key"),
    "scholar-inbox.abc123",
  );

  const firstUpdateHeaders = new Headers(requests[2].init.headers);
  const compatibilityHeaders = new Headers(requests[3].init.headers);
  assert.equal(
    firstUpdateHeaders.get("x-idempotency-key"),
    compatibilityHeaders.get("x-idempotency-key"),
  );
});

test("accepts configured MagicDNS suffix over HTTP", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-local-vault-magicdns-"));
  const tokenFile = join(directory, "token");
  await writeFile(tokenFile, "test-token\n", "utf8");
  const previousUrl = process.env.LOCAL_VAULT_URL;
  const previousTokenFile = process.env.LOCAL_VAULT_TOKEN_FILE;
  const previousSuffix = process.env.LOCAL_VAULT_TAILNET_DNS_SUFFIX;
  const originalFetch = globalThis.fetch;
  process.env.LOCAL_VAULT_URL = "http://desktop.hs.d0me.xyz:8088";
  process.env.LOCAL_VAULT_TOKEN_FILE = tokenFile;
  process.env.LOCAL_VAULT_TAILNET_DNS_SUFFIX = "hs.d0me.xyz";
  let requestedUrl = "";
  globalThis.fetch = (async (input: string | URL | Request) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  try {
    const tools = new Map<string, RegisteredTool>();
    localVault({
      registerTool(tool: RegisteredTool) {
        tools.set(tool.name, tool);
      },
    } as never);
    await tools.get("vault_read")?.execute("read", { question: "q" });
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("LOCAL_VAULT_URL", previousUrl);
    restoreEnv("LOCAL_VAULT_TOKEN_FILE", previousTokenFile);
    restoreEnv("LOCAL_VAULT_TAILNET_DNS_SUFFIX", previousSuffix);
  }

  assert.equal(requestedUrl, "http://desktop.hs.d0me.xyz:8088/v1/read");
});

test("does not accept a hostname outside the configured MagicDNS suffix", async () => {
  const previousUrl = process.env.LOCAL_VAULT_URL;
  const previousSuffix = process.env.LOCAL_VAULT_TAILNET_DNS_SUFFIX;
  process.env.LOCAL_VAULT_URL = "http://not-hs.d0me.xyz:8088";
  process.env.LOCAL_VAULT_TAILNET_DNS_SUFFIX = "hs.d0me.xyz";

  try {
    const tools = new Map<string, RegisteredTool>();
    localVault({
      registerTool(tool: RegisteredTool) {
        tools.set(tool.name, tool);
      },
    } as never);
    const read = tools.get("vault_read");
    assert.ok(read);
    await assert.rejects(read.execute("read", { question: "q" }), /must use HTTPS/);
  } finally {
    restoreEnv("LOCAL_VAULT_URL", previousUrl);
    restoreEnv("LOCAL_VAULT_TAILNET_DNS_SUFFIX", previousSuffix);
  }
});
