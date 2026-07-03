import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import legacy, { type Env as LegacyEnv } from "./index";

type ShellName = "bash" | "powershell";
type BundleMode = "archive" | "gomod" | "tidy";

type RepoRef = {
  owner: string;
  repo: string;
};

export interface Env extends LegacyEnv {
  GITHUB_ACTION_TOKEN?: string;
  GITHUB_ACTION_REPO?: string;
  GITHUB_ACTION_REF?: string;
  ACTIONS_MCP_BEARER_TOKEN?: string;
}

function textContent(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
    },
  });
}

function errorResponse(error: unknown, status = 400): Response {
  return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, status);
}

function getBearerToken(request: Request): string | null {
  const match = (request.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

function actionAuthToken(env: Env): string | undefined {
  return env.ACTIONS_MCP_BEARER_TOKEN || env.MCP_BEARER_TOKEN;
}

function isActionsMcpAuthorized(request: Request, env: Env): boolean {
  const token = actionAuthToken(env);
  return !token || getBearerToken(request) === token;
}

function splitRepoFullName(fullName: string): RepoRef {
  const value = fullName.trim();
  const parts = value.split("/").filter(Boolean);
  if (parts.length !== 2) {
    throw new Error("repository must be owner/repo");
  }
  return { owner: assertRepoPart(parts[0], "owner"), repo: assertRepoPart(parts[1], "repo") };
}

function parseGithubRepo(input: string): RepoRef {
  const raw = input.trim();
  let path = raw;
  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    if (url.hostname !== "github.com" && url.hostname !== "www.github.com") {
      throw new Error("only github.com repository URLs are supported");
    }
    path = url.pathname;
  }
  const parts = path.replace(/^\/+/, "").split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new Error("repository must be owner/repo or https://github.com/owner/repo");
  }
  return { owner: assertRepoPart(parts[0], "owner"), repo: assertRepoPart(parts[1], "repo") };
}

function assertRepoPart(value: string, fieldName: string): string {
  const decoded = decodeURIComponent(value.trim()).replace(/\.git$/i, "");
  if (!decoded || !/^[A-Za-z0-9_.-]+$/.test(decoded)) {
    throw new Error(`invalid GitHub ${fieldName}`);
  }
  return decoded;
}

function assertRef(value: string): string {
  const decoded = decodeURIComponent(value.trim());
  if (!decoded || decoded.includes("..") || decoded.includes("\\") || decoded.startsWith("/") || decoded.length > 200) {
    throw new Error("invalid GitHub ref");
  }
  return decoded;
}

function repoAllowed(repo: RepoRef, env: Env): boolean {
  const repoFull = `${repo.owner}/${repo.repo}`.toLowerCase();
  const owners = (env.GITHUB_ALLOW_OWNERS ?? "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  const repos = (env.GITHUB_ALLOW_REPOS ?? "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);

  if (repos.length > 0) return repos.includes(repoFull);
  if (owners.length > 0) return owners.includes(repo.owner.toLowerCase());
  return true;
}

function workflowRepo(env: Env): string {
  return env.GITHUB_ACTION_REPO || "aisphereio/mcp-server-go";
}

function workflowRef(env: Env): string {
  return env.GITHUB_ACTION_REF || "main";
}

function requestId(prefix: string): string {
  const entropy = crypto.getRandomValues(new Uint32Array(2));
  return `${prefix}-${Date.now().toString(36)}-${entropy[0].toString(36)}${entropy[1].toString(36)}`;
}

function githubHeaders(env: Env): Headers {
  if (!env.GITHUB_ACTION_TOKEN) {
    throw new Error("GITHUB_ACTION_TOKEN is required to trigger or inspect offline bundle jobs");
  }
  return new Headers({
    accept: "application/vnd.github+json",
    authorization: `Bearer ${env.GITHUB_ACTION_TOKEN}`,
    "content-type": "application/json",
    "user-agent": "aisphere-mcp-server-go",
    "x-github-api-version": "2022-11-28",
  });
}

async function dispatchOfflineBundle(env: Env, args: {
  targetRepo: string;
  targetRef: string;
  goVersion: string;
  mode: BundleMode;
  requestId?: string;
}): Promise<Record<string, unknown>> {
  const repo = parseGithubRepo(args.targetRepo);
  if (!repoAllowed(repo, env)) {
    throw new Error("GitHub repo is not allowed by GITHUB_ALLOW_OWNERS/GITHUB_ALLOW_REPOS");
  }

  const actionRepo = splitRepoFullName(workflowRepo(env));
  const id = args.requestId || requestId(args.mode);
  const endpoint = `https://api.github.com/repos/${actionRepo.owner}/${actionRepo.repo}/actions/workflows/offline-bundle.yml/dispatches`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: githubHeaders(env),
    body: JSON.stringify({
      ref: workflowRef(env),
      inputs: {
        request_id: id,
        mode: args.mode,
        target_repo: `${repo.owner}/${repo.repo}`,
        target_ref: assertRef(args.targetRef),
        go_version: args.goVersion || "1.26.4",
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`failed to dispatch workflow: ${response.status} ${body}`);
  }

  return {
    ok: true,
    requestId: id,
    mode: args.mode,
    targetRepo: `${repo.owner}/${repo.repo}`,
    targetRef: args.targetRef,
    goVersion: args.goVersion || "1.26.4",
    workflowRepo: workflowRepo(env),
    workflowRef: workflowRef(env),
    actionsUrl: `https://github.com/${workflowRepo(env)}/actions/workflows/offline-bundle.yml`,
    statusHint: "Call offline_bundle_status with this requestId after the GitHub Actions run starts.",
    note: "This creates a GitHub Actions artifact. It does not mount the artifact into the ChatGPT sandbox automatically.",
  };
}

async function offlineBundleStatus(env: Env, id: string): Promise<Record<string, unknown>> {
  const actionRepo = splitRepoFullName(workflowRepo(env));
  const runsUrl = `https://api.github.com/repos/${actionRepo.owner}/${actionRepo.repo}/actions/workflows/offline-bundle.yml/runs?per_page=20`;
  const runsResponse = await fetch(runsUrl, { headers: githubHeaders(env) });
  if (!runsResponse.ok) {
    const body = await runsResponse.text();
    throw new Error(`failed to list workflow runs: ${runsResponse.status} ${body}`);
  }

  const runsBody = (await runsResponse.json()) as { workflow_runs?: Array<Record<string, unknown>> };
  const runs = runsBody.workflow_runs ?? [];
  const matched = runs.find((run) => {
    const displayTitle = String(run.display_title ?? "");
    const name = String(run.name ?? "");
    const htmlUrl = String(run.html_url ?? "");
    return displayTitle.includes(id) || name.includes(id) || htmlUrl.includes(id);
  });

  if (!matched) {
    return {
      ok: false,
      requestId: id,
      workflowRepo: workflowRepo(env),
      message: "No matching run found yet. GitHub can take a few seconds to surface a workflow_dispatch run.",
      actionsUrl: `https://github.com/${workflowRepo(env)}/actions/workflows/offline-bundle.yml`,
    };
  }

  const runId = matched.id;
  let artifacts: unknown[] = [];
  if (runId) {
    const artifactsUrl = `https://api.github.com/repos/${actionRepo.owner}/${actionRepo.repo}/actions/runs/${runId}/artifacts?per_page=20`;
    const artifactsResponse = await fetch(artifactsUrl, { headers: githubHeaders(env) });
    if (artifactsResponse.ok) {
      const artifactsBody = (await artifactsResponse.json()) as { artifacts?: unknown[] };
      artifacts = artifactsBody.artifacts ?? [];
    }
  }

  return {
    ok: true,
    requestId: id,
    run: {
      id: matched.id,
      name: matched.name,
      displayTitle: matched.display_title,
      status: matched.status,
      conclusion: matched.conclusion,
      htmlUrl: matched.html_url,
      createdAt: matched.created_at,
      updatedAt: matched.updated_at,
    },
    artifacts,
    note: "Download artifacts from the GitHub Actions UI or through the GitHub API. Custom MCP connectors generally do not mount artifacts into /mnt/data automatically.",
  };
}

function makeRepoCommand(repo: string, ref: string, mode: BundleMode, shell: ShellName, requestId?: string): string {
  const idLine = requestId ? `# request_id: ${requestId}\n` : "";
  if (shell === "powershell") {
    return `${idLine}# Trigger this through MCP: mode=${mode}, repo=${repo}, ref=${ref}\n# Then call offline_bundle_status with the returned requestId.`;
  }
  return `${idLine}# Trigger this through MCP: mode=${mode}, repo=${repo}, ref=${ref}\n# Then call offline_bundle_status with the returned requestId.`;
}

function createActionsServer(env: Env) {
  const server = new McpServer({ name: "aisphere-go-actions-bridge", version: "0.4.0" });

  server.registerTool(
    "github_repo_archive_fetch",
    {
      description: "Trigger GitHub Actions to clone a GitHub repository/ref and upload a source archive artifact.",
      inputSchema: {
        repository: z.string().min(1).describe("owner/repo or https://github.com/owner/repo"),
        ref: z.string().default("main"),
        goVersion: z.string().default("1.26.4"),
        requestId: z.string().optional(),
      },
    },
    async ({ repository, ref, goVersion, requestId }) => {
      const result = await dispatchOfflineBundle(env, {
        targetRepo: repository,
        targetRef: ref,
        goVersion,
        mode: "archive",
        requestId,
      });
      return textContent(JSON.stringify(result, null, 2));
    },
  );

  server.registerTool(
    "go_mod_download_bundle",
    {
      description: "Trigger GitHub Actions to clone a repo, run go mod download, and upload repo source plus GOMODCACHE artifact.",
      inputSchema: {
        repository: z.string().min(1).describe("owner/repo or https://github.com/owner/repo"),
        ref: z.string().default("main"),
        goVersion: z.string().default("1.26.4"),
        requestId: z.string().optional(),
      },
    },
    async ({ repository, ref, goVersion, requestId }) => {
      const result = await dispatchOfflineBundle(env, {
        targetRepo: repository,
        targetRef: ref,
        goVersion,
        mode: "gomod",
        requestId,
      });
      return textContent(JSON.stringify(result, null, 2));
    },
  );

  server.registerTool(
    "go_mod_tidy_remote",
    {
      description: "Trigger GitHub Actions to clone a repo, run go mod tidy, capture logs/diff, and upload an artifact.",
      inputSchema: {
        repository: z.string().min(1).describe("owner/repo or https://github.com/owner/repo"),
        ref: z.string().default("main"),
        goVersion: z.string().default("1.26.4"),
        requestId: z.string().optional(),
      },
    },
    async ({ repository, ref, goVersion, requestId }) => {
      const result = await dispatchOfflineBundle(env, {
        targetRepo: repository,
        targetRef: ref,
        goVersion,
        mode: "tidy",
        requestId,
      });
      return textContent(JSON.stringify(result, null, 2));
    },
  );

  server.registerTool(
    "offline_bundle_status",
    {
      description: "Find the GitHub Actions run/artifacts created by github_repo_archive_fetch, go_mod_download_bundle, or go_mod_tidy_remote.",
      inputSchema: {
        requestId: z.string().min(1),
      },
    },
    async ({ requestId }) => textContent(JSON.stringify(await offlineBundleStatus(env, requestId), null, 2)),
  );

  server.registerTool(
    "offline_bundle_plan",
    {
      description: "Explain the remote artifact workflow and return suggested parameters without triggering a job.",
      inputSchema: {
        repository: z.string().min(1),
        ref: z.string().default("main"),
        mode: z.enum(["archive", "gomod", "tidy"]).default("gomod"),
        shell: z.enum(["bash", "powershell"]).default("bash"),
      },
    },
    async ({ repository, ref, mode, shell }) => {
      const repo = parseGithubRepo(repository);
      if (!repoAllowed(repo, env)) throw new Error("GitHub repo is not allowed");
      return textContent(JSON.stringify({
        repository: `${repo.owner}/${repo.repo}`,
        ref: assertRef(ref),
        mode,
        workflowRepo: workflowRepo(env),
        workflowRef: workflowRef(env),
        command: makeRepoCommand(`${repo.owner}/${repo.repo}`, ref, mode, shell),
        tools: {
          archive: "github_repo_archive_fetch",
          gomod: "go_mod_download_bundle",
          tidy: "go_mod_tidy_remote",
          status: "offline_bundle_status",
        },
        boundary: "The MCP tool triggers GitHub Actions and returns artifact metadata. It cannot directly mount large files into /mnt/data.",
      }, null, 2));
    },
  );

  return server;
}

async function handleActionsHttp(request: Request, env: Env): Promise<Response> {
  if (!isActionsMcpAuthorized(request, env)) {
    return new Response("unauthorized", { status: 401, headers: { "www-authenticate": "Bearer" } });
  }
  const url = new URL(request.url);
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "authorization, content-type",
      },
    });
  }

  if (url.pathname === "/actions/status") {
    const id = url.searchParams.get("request_id") || url.searchParams.get("requestId");
    if (!id) return jsonResponse({ error: "missing request_id" }, 400);
    return jsonResponse(await offlineBundleStatus(env, id));
  }

  if (url.pathname === "/actions/offline-bundle") {
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    const body = (await request.json()) as {
      repository: string;
      ref?: string;
      goVersion?: string;
      mode?: BundleMode;
      requestId?: string;
    };
    return jsonResponse(await dispatchOfflineBundle(env, {
      targetRepo: body.repository,
      targetRef: body.ref || "main",
      goVersion: body.goVersion || "1.26.4",
      mode: body.mode || "gomod",
      requestId: body.requestId,
    }));
  }

  return jsonResponse({ error: "not_found" }, 404);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/mcp-actions" || url.pathname.startsWith("/mcp-actions/")) {
        if (!isActionsMcpAuthorized(request, env)) {
          return new Response("unauthorized", { status: 401, headers: { "www-authenticate": "Bearer" } });
        }
        return createMcpHandler(createActionsServer(env))(request, env, ctx);
      }
      if (url.pathname === "/actions/offline-bundle" || url.pathname === "/actions/status") {
        return handleActionsHttp(request, env);
      }
      return legacy.fetch(request, env, ctx);
    } catch (error) {
      return errorResponse(error, 400);
    }
  },
} satisfies ExportedHandler<Env>;
