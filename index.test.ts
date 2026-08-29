import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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
  assert.match(read.description, /first source/);
  assert.deepEqual(
    Object.keys(read.parameters.properties ?? {}).sort(),
    ["question", "searchBudget"],
  );

  const update = tools.get("vault_update");
  assert.ok(update);
  assert.equal(update.loadMode, "essential");
  assert.ok(update.parameters.required?.includes("context"));
  assert.match(update.description, /self-contained instruction and context/);

  const jobStatus = tools.get("vault_job_status");
  assert.ok(jobStatus);
  assert.equal(jobStatus.loadMode, undefined);
  assert.match(jobStatus.description, /maintenance and debugging only/);
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
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(requests.map((request) => request.url), [
    "http://127.0.0.1:8088/v1/read",
    "http://127.0.0.1:8088/v1/get",
    "http://127.0.0.1:8088/v1/updates",
    "http://127.0.0.1:8088/v1/update",
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

  const firstUpdateHeaders = new Headers(requests[2].init.headers);
  const compatibilityHeaders = new Headers(requests[3].init.headers);
  assert.equal(
    firstUpdateHeaders.get("x-idempotency-key"),
    compatibilityHeaders.get("x-idempotency-key"),
  );
});
