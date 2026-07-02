import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export interface Env {
  UPSTREAM_GOPROXY?: string;
  PROXY_TOKEN?: string;
  MCP_BEARER_TOKEN?: string;
  ALLOW_MODULE_PREFIXES?: string;
  BLOCK_MODULE_PREFIXES?: string;
}

type McpContent = { type: "text"; text: string };

type ModuleRef = {
  module: string;
  version: string;
  indirect: boolean;
};

const DEFAULT_UPSTREAM_GOPROXY = "https://proxy.golang.org";
const MAX_MCP_TEXT_BYTES = 64 * 1024;

function textContent(text: string): { content: McpContent[] } {
  return { content: [{ type: "text", text }] };
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

function normalizeUpstream(raw?: string): string {
  const base = raw?.trim() || DEFAULT_UPSTREAM_GOPROXY;
  const url = new URL(base);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("UPSTREAM_GOPROXY must be http(s)");
  }
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

function splitCsv(raw?: string): string[] {
  return (raw ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function moduleAllowed(escapedModulePath: string, env: Env): boolean {
  const allow = splitCsv(env.ALLOW_MODULE_PREFIXES);
  const block = splitCsv(env.BLOCK_MODULE_PREFIXES);

  if (block.some((prefix) => escapedModulePath.startsWith(goEscapePath(prefix)))) {
    return false;
  }
  if (allow.length === 0) {
    return true;
  }
  return allow.some((prefix) => escapedModulePath.startsWith(goEscapePath(prefix)));
}

function getBearerToken(request: Request): string | null {
  const auth = request.headers.get("authorization") ?? "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

function isMcpAuthorized(request: Request, env: Env): boolean {
  if (!env.MCP_BEARER_TOKEN) return true;
  return getBearerToken(request) === env.MCP_BEARER_TOKEN;
}

function isProxyAuthorized(request: Request, env: Env, restPath: string): { ok: boolean; suffix?: string } {
  const token = env.PROXY_TOKEN;
  if (!token) return { ok: true, suffix: restPath };

  const headerToken = request.headers.get("x-proxy-token") || getBearerToken(request);
  if (headerToken === token) return { ok: true, suffix: restPath };

  const encodedTokenPrefix = `/${encodeURIComponent(token)}`;
  if (restPath === encodedTokenPrefix) return { ok: false };
  if (restPath.startsWith(`${encodedTokenPrefix}/`)) {
    return { ok: true, suffix: restPath.slice(encodedTokenPrefix.length) };
  }

  return { ok: false };
}

function modulePathFromProxySuffix(suffix: string): string {
  const clean = suffix.replace(/^\/+/, "");
  const marker = "/@v/";
  const idx = clean.indexOf(marker);
  return idx >= 0 ? clean.slice(0, idx) : clean;
}

function validateProxySuffix(suffix: string, env: Env): string | Response {
  if (!suffix.startsWith("/")) {
    return new Response("bad proxy path", { status: 400 });
  }
  if (suffix.includes("://") || suffix.includes("..") || suffix.includes("//")) {
    return new Response("bad proxy path", { status: 400 });
  }
  const modulePath = modulePathFromProxySuffix(suffix);
  if (!modulePath || modulePath.startsWith("@")) {
    return new Response("missing module path", { status: 400 });
  }
  if (!moduleAllowed(modulePath, env)) {
    return new Response("module path is not allowed", { status: 403 });
  }
  return suffix;
}

async function fetchGoProxySuffix(suffix: string, env: Env, request?: Request): Promise<Response> {
  const valid = validateProxySuffix(suffix, env);
  if (valid instanceof Response) return valid;

  const upstreamBase = normalizeUpstream(env.UPSTREAM_GOPROXY);
  const upstreamUrl = `${upstreamBase}${valid}`;
  const headers = new Headers();

  const accept = request?.headers.get("accept");
  const userAgent = request?.headers.get("user-agent");
  if (accept) headers.set("accept", accept);
  if (userAgent) headers.set("user-agent", userAgent);

  return fetch(upstreamUrl, {
    method: request?.method ?? "GET",
    headers,
    cf: {
      cacheEverything: true,
      cacheTtlByStatus: {
        "200-299": 86400,
        "300-399": 3600,
        "404": 300,
        "500-599": 0,
      },
    },
  });
}

async function handleGoProxy(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, HEAD, OPTIONS",
        "access-control-allow-headers": "authorization, x-proxy-token, content-type",
      },
    });
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("method not allowed", { status: 405 });
  }

  const url = new URL(request.url);
  const restPath = url.pathname.slice("/proxy".length) || "/";
  const auth = isProxyAuthorized(request, env, restPath);
  if (!auth.ok || !auth.suffix) {
    return new Response("unauthorized", { status: 401 });
  }

  const upstreamResponse = await fetchGoProxySuffix(`${auth.suffix}${url.search}`, env, request);
  const headers = new Headers(upstreamResponse.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("x-aisphere-mcp-server", "mcp-server-go");
  headers.set("x-aisphere-upstream", normalizeUpstream(env.UPSTREAM_GOPROXY));

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  });
}

function escapeUpper(input: string): string {
  return input.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`);
}

function goEscapePath(modulePath: string): string {
  return modulePath
    .split("/")
    .map((segment) => encodeURIComponent(escapeUpper(segment)))
    .join("/");
}

function goEscapeVersion(version: string): string {
  return encodeURIComponent(escapeUpper(version));
}

function buildGoProxySuffix(modulePath: string, artifact: "list" | "latest" | "mod" | "info" | "zip", version?: string): string {
  const escapedModule = goEscapePath(modulePath.trim());
  if (!escapedModule || escapedModule.startsWith(".")) {
    throw new Error("invalid module path");
  }
  if (artifact === "list") return `/${escapedModule}/@v/list`;
  if (artifact === "latest") return `/${escapedModule}/@latest`;
  if (!version) throw new Error(`${artifact} requires version`);

  const escapedVersion = goEscapeVersion(version.trim());
  return `/${escapedModule}/@v/${escapedVersion}.${artifact}`;
}

async function readSmallText(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length") || "0");
  if (contentLength > MAX_MCP_TEXT_BYTES) {
    return `[body omitted: ${contentLength} bytes is too large for MCP text response]`;
  }

  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength <= MAX_MCP_TEXT_BYTES) {
    return text;
  }
  return `${text.slice(0, MAX_MCP_TEXT_BYTES)}\n\n[truncated for MCP text response]`;
}

function parseGoModRequires(goMod: string, maxModules: number): ModuleRef[] {
  const result: ModuleRef[] = [];
  let inRequireBlock = false;

  for (const rawLine of goMod.split(/\r?\n/)) {
    let line = rawLine.replace(/\/\/.*$/, "").trim();
    if (!line) continue;

    if (line === "require (") {
      inRequireBlock = true;
      continue;
    }
    if (inRequireBlock && line === ")") {
      inRequireBlock = false;
      continue;
    }
    if (line.startsWith("require ")) {
      line = line.slice("require ".length).trim();
    } else if (!inRequireBlock) {
      continue;
    }

    const parts = line.split(/\s+/);
    if (parts.length >= 2) {
      result.push({
        module: parts[0],
        version: parts[1],
        indirect: parts.includes("indirect"),
      });
    }
    if (result.length >= maxModules) break;
  }

  return result;
}

function proxyBaseUrl(origin: string, env: Env): string {
  if (env.PROXY_TOKEN) {
    return `${origin}/proxy/${encodeURIComponent(env.PROXY_TOKEN)}`;
  }
  return `${origin}/proxy`;
}

function createServer(origin: string, env: Env) {
  const server = new McpServer({
    name: "aisphere-go-network-bridge",
    version: "0.1.0",
  });

  server.registerTool(
    "go_proxy_config",
    {
      description: "Return GOPROXY commands that route Go module downloads through this Cloudflare server.",
      inputSchema: {
        shell: z.enum(["bash", "powershell"]).default("bash"),
      },
    },
    async ({ shell }) => {
      const base = proxyBaseUrl(origin, env);
      const cmd =
        shell === "powershell"
          ? `$env:GOPROXY=\"${base},direct\"\n$env:GOSUMDB=\"sum.golang.org\"\ngo env GOPROXY GOSUMDB\ngo mod tidy`
          : `export GOPROXY=\"${base},direct\"\nexport GOSUMDB=\"sum.golang.org\"\ngo env GOPROXY GOSUMDB\ngo mod tidy`;

      return textContent(
        [
          "Use this in an environment that can reach Cloudflare but cannot reach proxy.golang.org directly:",
          "",
          cmd,
          "",
          "This is a Go module proxy bridge, not a generic TCP/HTTP CONNECT proxy.",
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "go_proxy_fetch",
    {
      description: "Fetch a small Go module proxy artifact through the configured upstream Go proxy. Do not use this for large .zip bodies.",
      inputSchema: {
        module: z.string().min(1).describe("Go module path, for example github.com/gin-gonic/gin"),
        artifact: z.enum(["list", "latest", "mod", "info", "zip"]).default("latest"),
        version: z.string().optional().describe("Required for mod/info/zip, for example v1.10.0"),
      },
    },
    async ({ module, artifact, version }) => {
      const suffix = buildGoProxySuffix(module, artifact, version);
      const response = await fetchGoProxySuffix(suffix, env);
      const body = artifact === "zip" ? "[zip body omitted; use GOPROXY /proxy endpoint to stream it]" : await readSmallText(response);

      return textContent(
        JSON.stringify(
          {
            module,
            artifact,
            version,
            status: response.status,
            contentType: response.headers.get("content-type"),
            upstream: normalizeUpstream(env.UPSTREAM_GOPROXY),
            proxyPath: suffix,
            body,
          },
          null,
          2,
        ),
      );
    },
  );

  server.registerTool(
    "go_mod_preflight",
    {
      description: "Parse a go.mod file and check whether direct require entries are reachable via the upstream Go proxy.",
      inputSchema: {
        goMod: z.string().min(1),
        maxModules: z.number().int().min(1).max(100).default(30),
      },
    },
    async ({ goMod, maxModules }) => {
      const refs = parseGoModRequires(goMod, maxModules);
      const checks = [];

      for (const ref of refs) {
        const suffix = buildGoProxySuffix(ref.module, "mod", ref.version);
        const response = await fetchGoProxySuffix(suffix, env);
        checks.push({
          module: ref.module,
          version: ref.version,
          indirect: ref.indirect,
          status: response.status,
          ok: response.ok,
          proxyPath: suffix,
        });
      }

      return textContent(
        JSON.stringify(
          {
            upstream: normalizeUpstream(env.UPSTREAM_GOPROXY),
            proxyBase: proxyBaseUrl(origin, env),
            checked: checks.length,
            checks,
            note: "This preflight checks declared require entries only. go mod tidy still needs the Go tool locally to resolve imports, tests, and transitive requirements.",
          },
          null,
          2,
        ),
      );
    },
  );

  return server;
}

function landing(origin: string, env: Env): Response {
  const base = proxyBaseUrl(origin, env);
  return new Response(
    [
      "aisphere mcp-server-go",
      "",
      "Endpoints:",
      `- MCP: ${origin}/mcp`,
      `- Go proxy: ${base}`,
      `- Health: ${origin}/health`,
      "",
      "PowerShell:",
      `$env:GOPROXY=\"${base},direct\"`,
      "$env:GOSUMDB=\"sum.golang.org\"",
      "go mod tidy",
      "",
      "Bash:",
      `export GOPROXY=\"${base},direct\"`,
      "export GOSUMDB=\"sum.golang.org\"",
      "go mod tidy",
      "",
      `Upstream Go proxy: ${normalizeUpstream(env.UPSTREAM_GOPROXY)}`,
    ].join("\n"),
    { headers: { "content-type": "text/plain; charset=utf-8" } },
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return jsonResponse({
        ok: true,
        service: "mcp-server-go",
        mcp: `${url.origin}/mcp`,
        proxy: proxyBaseUrl(url.origin, env),
        upstream: normalizeUpstream(env.UPSTREAM_GOPROXY),
      });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return landing(url.origin, env);
    }

    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      if (!isMcpAuthorized(request, env)) {
        return new Response("unauthorized", {
          status: 401,
          headers: { "www-authenticate": "Bearer" },
        });
      }
      const server = createServer(url.origin, env);
      return createMcpHandler(server)(request, env, ctx);
    }

    if (url.pathname === "/proxy" || url.pathname.startsWith("/proxy/")) {
      return handleGoProxy(request, env);
    }

    return jsonResponse({ error: "not_found", mcp: `${url.origin}/mcp`, proxy: proxyBaseUrl(url.origin, env) }, 404);
  },
} satisfies ExportedHandler<Env>;
