import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const REQUEST_TIMEOUT_MS = 120_000;
const MAX_ERROR_BODY_CHARS = 2_000;

type JsonPayload = null | boolean | number | string | JsonPayload[] | { [key: string]: JsonPayload };

class RemoteVaultHttpError extends Error {
  constructor(
    readonly status: number,
    readonly payload: JsonPayload,
    message: string,
  ) {
    super(message);
    this.name = "RemoteVaultHttpError";
  }
}

function isTailnetIpv4(hostname: string): boolean {
  const octets = hostname.split(".");
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet))) {
    return false;
  }
  const values = octets.map(Number);
  return values.every((value) => value >= 0 && value <= 255) && values[0] === 100 && values[1] >= 64 && values[1] <= 127;
}

function tailnetDnsSuffix(): string | undefined {
  const raw = process.env.LOCAL_VAULT_TAILNET_DNS_SUFFIX?.trim();
  if (!raw) return undefined;
  const suffix = raw.replace(/^\./, "").replace(/\.$/, "").toLowerCase();
  if (
    suffix.length > 253 ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(suffix) ||
    suffix.includes("..")
  ) {
    throw new Error("LOCAL_VAULT_TAILNET_DNS_SUFFIX must be a valid DNS suffix");
  }
  return suffix;
}

function isTailnetDnsName(hostname: string, suffix: string | undefined): boolean {
  return suffix !== undefined && hostname.toLowerCase().endsWith(`.${suffix}`);
}

function remoteConfig(): { baseUrl: string; tokenFile: string } {
  const configuredUrl = process.env.LOCAL_VAULT_URL ?? "http://127.0.0.1:8088";
  const tokenFile =
    process.env.LOCAL_VAULT_TOKEN_FILE ?? join(homedir(), ".config", "pi", "local-vault.token");

  let url: URL;
  try {
    url = new URL(configuredUrl);
  } catch {
    throw new Error("LOCAL_VAULT_URL must be a valid absolute HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("LOCAL_VAULT_URL must use HTTP or HTTPS");
  }
  const loopbackHosts: Record<string, true> = {
    "127.0.0.1": true,
    localhost: true,
    "::1": true,
    "[::1]": true,
  };
  const dnsSuffix = tailnetDnsSuffix();
  if (
    url.protocol === "http:" &&
    !loopbackHosts[url.hostname] &&
    !isTailnetIpv4(url.hostname) &&
    !isTailnetDnsName(url.hostname, dnsSuffix)
  ) {
    throw new Error(
      "LOCAL_VAULT_URL must use HTTPS except for loopback, Tailnet IPv4 " +
        "(100.64.0.0/10), or a hostname below LOCAL_VAULT_TAILNET_DNS_SUFFIX",
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("LOCAL_VAULT_URL must not contain credentials, a query, or a fragment");
  }

  return { baseUrl: url.toString().replace(/\/$/, ""), tokenFile };
}

async function bearerToken(tokenFile: string): Promise<string> {
  let token: string;
  try {
    token = (await readFile(tokenFile, "utf8")).trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read LOCAL_VAULT_TOKEN_FILE: ${detail}`);
  }
  if (!token) {
    throw new Error("LOCAL_VAULT_TOKEN_FILE is empty");
  }
  return token;
}

function parsePayload(body: string): JsonPayload {
  if (!body) return null;
  try {
    return JSON.parse(body) as JsonPayload;
  } catch {
    return body;
  }
}

function errorDetail(payload: JsonPayload): string {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return (text || "empty response body").slice(0, MAX_ERROR_BODY_CHARS);
}

async function request(
  method: "GET" | "POST",
  endpoint:
    | "/v1/read"
    | "/v1/get"
    | "/v1/updates"
    | "/v1/update"
    | "/v1/research"
    | `/v1/jobs/${string}`,
  body: unknown,
  signal?: AbortSignal,
  idempotencyKey?: string,
): Promise<JsonPayload> {
  const { baseUrl, tokenFile } = remoteConfig();
  const token = await bearerToken(tokenFile);
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${token}`,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (idempotencyKey) headers["x-idempotency-key"] = idempotencyKey;

    let response: Response;
    try {
      response = await fetch(`${baseUrl}${endpoint}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut) {
        throw new Error(`Remote Vault request timed out after ${REQUEST_TIMEOUT_MS} ms`);
      }
      if (signal?.aborted) throw new Error("Remote Vault request was aborted");
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Remote Vault network error: ${detail}`);
    }

    let responseBody: string;
    try {
      responseBody = await response.text();
    } catch (error) {
      if (timedOut) {
        throw new Error(`Remote Vault request timed out after ${REQUEST_TIMEOUT_MS} ms`);
      }
      if (signal?.aborted) throw new Error("Remote Vault request was aborted");
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Remote Vault network error while reading the response: ${detail}`);
    }

    const payload = parsePayload(responseBody);
    if (!response.ok) {
      throw new RemoteVaultHttpError(
        response.status,
        payload,
        `Remote Vault ${method} ${endpoint} failed with HTTP ${response.status}: ${errorDetail(payload)}`,
      );
    }
    return payload;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

async function submitUpdate(args: unknown, signal?: AbortSignal): Promise<JsonPayload> {
  const idempotencyKey = randomUUID();
  try {
    return await request("POST", "/v1/updates", args, signal, idempotencyKey);
  } catch (error) {
    if (!(error instanceof RemoteVaultHttpError) || (error.status !== 404 && error.status !== 405)) {
      throw error;
    }
    return request("POST", "/v1/update", args, signal, idempotencyKey);
  }
}

function toolResult(payload: JsonPayload) {
  return {
    content: [{ type: "text" as const, text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

const updateContext = Type.String({
  minLength: 1,
  maxLength: 65_536,
  description:
    "Self-contained evidence and surrounding facts needed to curate the update correctly without access to the caller's conversation, workspace, or unstated context.",
});
const optionalUpdateTargetPath = Type.Optional(Type.String({
  minLength: 1,
  maxLength: 1_024,
  description:
    "Placement suggestion only. Use when a prior vault_get identified the specific relevant or stale note; otherwise omit and let the writer navigate.",
}));
// OMP consumes loadMode; standard Pi safely ignores the extra runtime property.
// Spreading it avoids requiring standard Pi's ToolDefinition type to declare it.
const essentialToolPresentation = { loadMode: "essential" as const };


export default function remoteVault(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "vault_read",
    label: "Read Remote Vault",
    ...essentialToolPresentation,
    description: "Retrieve relevant context from the authenticated Knowledge Vault. Use it as the first source whenever a task may depend on prior project knowledge, decisions, research, infrastructure, discussions, or user context. Ask a focused question; use thorough only when broader coverage is necessary.",
    parameters: Type.Object(
      {
        question: Type.String({ minLength: 1, maxLength: 32_768 }),
        searchBudget: Type.Optional(
          Type.Union([Type.Literal("default"), Type.Literal("thorough")]),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, args, signal) {
      const { question, ...options } = args;
      return toolResult(await request("POST", "/v1/read", { query: question, ...options }, signal));
    },
  });

  pi.registerTool({
    name: "vault_get",
    label: "Fetch Bound Vault Note",
    description: "Fetch one full canonical note previously surfaced by `vault_read`. Use sparingly and only when that node is highly relevant and the returned excerpts omit context essential to the current task. Do not browse, enumerate, or fetch merely because a candidate looks related. Both IDs must come from the same unexpired `vault_read`.",
    parameters: Type.Object(
      {
        retrievalId: Type.String({ format: "uuid" }),
        nodeId: Type.String({ pattern: "^N\\\\d{3,}$" }),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, args, signal) {
      return toolResult(await request("POST", "/v1/get", args, signal));
    },
  });

  pi.registerTool({
    name: "vault_job_status",
    label: "Remote Vault Job Status",
    description: "Administrative diagnostic for Local Vault maintenance and debugging only. Poll one durable update or research job by its service-issued identifier; do not use during ordinary knowledge retrieval or project work.",
    parameters: Type.Object(
      { jobId: Type.String({ minLength: 1, maxLength: 256 }) },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, args, signal) {
      return toolResult(
        await request("GET", `/v1/jobs/${encodeURIComponent(args.jobId)}`, undefined, signal),
      );
    },
  });

  if (process.env.LOCAL_VAULT_READONLY !== "1" && process.env.WH_SESSION_ROLE?.trim() !== "task") {
    pi.registerTool({
      name: "vault_update",
      label: "Update Durable Vault Knowledge",
      ...essentialToolPresentation,
      description: "Save or revise durable knowledge in the remote Vault. Use when you identify new durable facts, decisions, discussions, research findings, or major project updates, especially when earlier Vault retrieval omitted relevant information. Supply self-contained instruction and context sufficient for curation without access to your conversation or workspace. Do not use for temporary symptoms, task state, or raw chronology.",
      parameters: Type.Object(
        {
          instruction: Type.String({
            minLength: 1,
            maxLength: 65_536,
            description: "State exactly what durable knowledge should be added, corrected, reconciled, or reorganized and why it matters.",
          }),
          context: updateContext,
          targetPath: optionalUpdateTargetPath,
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, args, signal) {
        return toolResult(await submitUpdate(args, signal));
      },
    });

    pi.registerTool({
      name: "vault_research",
      label: "Research Durable Vault Knowledge",
      description: "Research and save durable, future-useful knowledge in the remote Vault. Do not use for transient debugging, one-off symptoms, or task logs; keep those in project-local Markdown inside the project's working directory. Returns the asynchronous Vault job identifier/state.",
      parameters: Type.Object(
        {
          topic: Type.String({
            minLength: 1,
            maxLength: 32_768,
            description: "A durable research question whose findings are likely to remain useful beyond the current task.",
          }),
          idempotencyKey: Type.Optional(Type.String({
            minLength: 1,
            maxLength: 256,
            pattern: "^[A-Za-z0-9._:-]+$",
            description:
              "Stable caller key for unattended ingestion retries. Omit for ordinary interactive research.",
          })),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, args, signal) {
        const { idempotencyKey, ...payload } = args;
        return toolResult(
          await request(
            "POST",
            "/v1/research",
            payload,
            signal,
            idempotencyKey ?? randomUUID(),
          ),
        );
      },
    });
  }
}
