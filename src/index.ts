import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export interface Env {
  UPSTREAM_GOPROXY?: string;
  PROXY_TOKEN?: string;
  DOWNLOAD_TOKEN?: string;
  GITHUB_PROXY_TOKEN?: string;
  MCP_BEARER_TOKEN?: string;
  ALLOW_MODULE_PREFIXES?: string;
  BLOCK_MODULE_PREFIXES?: string;
  DOWNLOAD_ALLOW_TOOLS?: string;
  DEFAULT_GO_VERSION?: string;
  DEFAULT_BUF_VERSION?: string;
  DEFAULT_PROTOC_VERSION?: string;
  GITHUB_ALLOW_OWNERS?: string;
  GITHUB_ALLOW_REPOS?: string;
  GITHUB_TOKEN?: string;
}

type McpContent = { type: "text"; text: string };
type ToolName = "go" | "buf" | "protoc";
type ShellName = "bash" | "powershell";
type ArchiveFormat = "zip" | "tar.gz";

type ModuleRef = { module: string; version: string; indirect: boolean };
type RepoRef = { owner: string; repo: string };
type DownloadSpec = {
  tool: ToolName;
  version: string;
  os: string;
  arch: string;
  filename: string;
  upstreamUrl: string;
  contentType: string;
  notes: string[];
};

const DEFAULT_UPSTREAM_GOPROXY = "https://proxy.golang.org";
const MAX_MCP_TEXT_BYTES = 64 * 1024;
const CURRENT_SAFE_GO_VERSION = "go1.26.4";
const CURRENT_SAFE_BUF_VERSION = "v1.71.0";
const CURRENT_SAFE_PROTOC_VERSION = "35.1";

function textContent(text: string): { content: McpContent[] } {
  return { content: [{ type: "text", text }] };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" },
  });
}

function errorResponse(error: unknown, status = 400): Response {
  return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, status);
}

function splitCsv(raw?: string): string[] {
  return (raw ?? "").split(",").map((v) => v.trim()).filter(Boolean);
}

function normalizeUpstream(raw?: string): string {
  const base = raw?.trim() || DEFAULT_UPSTREAM_GOPROXY;
  const url = new URL(base);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("UPSTREAM_GOPROXY must be http(s)");
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

function getBearerToken(request: Request): string | null {
  const match = (request.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

function isMcpAuthorized(request: Request, env: Env): boolean {
  return !env.MCP_BEARER_TOKEN || getBearerToken(request) === env.MCP_BEARER_TOKEN;
}

function pathTokenAuth(request: Request, token: string | undefined, restPath: string, headerNames: string[]): { ok: boolean; suffix?: string } {
  if (!token) return { ok: true, suffix: restPath };

  for (const headerName of headerNames) {
    if (request.headers.get(headerName) === token) return { ok: true, suffix: restPath };
  }
  if (getBearerToken(request) === token) return { ok: true, suffix: restPath };

  const encoded = `/${encodeURIComponent(token)}`;
  if (restPath.startsWith(`${encoded}/`)) return { ok: true, suffix: restPath.slice(encoded.length) };
  return { ok: false };
}

function proxyToken(env: Env): string | undefined {
  return env.PROXY_TOKEN;
}

function downloadToken(env: Env): string | undefined {
  return env.DOWNLOAD_TOKEN || env.PROXY_TOKEN;
}

function githubToken(env: Env): string | undefined {
  return env.GITHUB_PROXY_TOKEN || env.PROXY_TOKEN || env.DOWNLOAD_TOKEN;
}

function proxyBaseUrl(origin: string, env: Env): string {
  const token = proxyToken(env);
  return token ? `${origin}/proxy/${encodeURIComponent(token)}` : `${origin}/proxy`;
}

function downloadBaseUrl(origin: string, env: Env): string {
  const token = downloadToken(env);
  return token ? `${origin}/download/${encodeURIComponent(token)}` : `${origin}/download`;
}

function gitBaseUrl(origin: string, env: Env): string {
  const token = githubToken(env);
  return token ? `${origin}/git/${encodeURIComponent(token)}` : `${origin}/git`;
}

function githubBaseUrl(origin: string, env: Env): string {
  const token = githubToken(env);
  return token ? `${origin}/github/${encodeURIComponent(token)}` : `${origin}/github`;
}

function escapeUpper(input: string): string {
  return input.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`);
}

function goEscapePath(modulePath: string): string {
  return modulePath.split("/").map((segment) => encodeURIComponent(escapeUpper(segment))).join("/");
}

function goEscapeVersion(version: string): string {
  return encodeURIComponent(escapeUpper(version));
}

function moduleAllowed(escapedModulePath: string, env: Env): boolean {
  const allow = splitCsv(env.ALLOW_MODULE_PREFIXES);
  const block = splitCsv(env.BLOCK_MODULE_PREFIXES);
  if (block.some((prefix) => escapedModulePath.startsWith(goEscapePath(prefix)))) return false;
  return allow.length === 0 || allow.some((prefix) => escapedModulePath.startsWith(goEscapePath(prefix)));
}

function buildGoProxySuffix(modulePath: string, artifact: "list" | "latest" | "mod" | "info" | "zip", version?: string): string {
  const escapedModule = goEscapePath(modulePath.trim());
  if (!escapedModule || escapedModule.startsWith(".")) throw new Error("invalid module path");
  if (artifact === "list") return `/${escapedModule}/@v/list`;
  if (artifact === "latest") return `/${escapedModule}/@latest`;
  if (!version) throw new Error(`${artifact} requires version`);
  return `/${escapedModule}/@v/${goEscapeVersion(version.trim())}.${artifact}`;
}

function modulePathFromProxySuffix(suffix: string): string {
  const clean = suffix.replace(/^\/+/, "");
  const idx = clean.indexOf("/@v/");
  return idx >= 0 ? clean.slice(0, idx) : clean;
}

function validateProxySuffix(suffix: string, env: Env): string | Response {
  if (!suffix.startsWith("/") || suffix.includes("://") || suffix.includes("..") || suffix.includes("//")) {
    return new Response("bad proxy path", { status: 400 });
  }
  const modulePath = modulePathFromProxySuffix(suffix);
  if (!modulePath || modulePath.startsWith("@")) return new Response("missing module path", { status: 400 });
  if (!moduleAllowed(modulePath, env)) return new Response("module path is not allowed", { status: 403 });
  return suffix;
}

async function fetchGoProxySuffix(suffix: string, env: Env, request?: Request): Promise<Response> {
  const valid = validateProxySuffix(suffix, env);
  if (valid instanceof Response) return valid;
  const headers = new Headers();
  const accept = request?.headers.get("accept");
  const userAgent = request?.headers.get("user-agent");
  if (accept) headers.set("accept", accept);
  if (userAgent) headers.set("user-agent", userAgent);
  return fetch(`${normalizeUpstream(env.UPSTREAM_GOPROXY)}${valid}`, {
    method: request?.method ?? "GET",
    headers,
    cf: { cacheEverything: true, cacheTtlByStatus: { "200-299": 86400, "300-399": 3600, "404": 300, "500-599": 0 } },
  });
}

async function handleGoProxy(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return corsOptions("GET, HEAD, OPTIONS", "authorization, x-proxy-token, content-type");
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("method not allowed", { status: 405 });
  const url = new URL(request.url);
  const auth = pathTokenAuth(request, proxyToken(env), url.pathname.slice("/proxy".length) || "/", ["x-proxy-token"]);
  if (!auth.ok || !auth.suffix) return new Response("unauthorized", { status: 401 });
  const upstream = await fetchGoProxySuffix(`${auth.suffix}${url.search}`, env, request);
  const headers = new Headers(upstream.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("x-aisphere-mcp-server", "mcp-server-go");
  headers.set("x-aisphere-upstream", normalizeUpstream(env.UPSTREAM_GOPROXY));
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
}

async function readSmallText(response: Response): Promise<string> {
  const length = Number(response.headers.get("content-length") || "0");
  if (length > MAX_MCP_TEXT_BYTES) return `[body omitted: ${length} bytes is too large for MCP text response]`;
  const text = await response.text();
  return new TextEncoder().encode(text).byteLength <= MAX_MCP_TEXT_BYTES ? text : `${text.slice(0, MAX_MCP_TEXT_BYTES)}\n\n[truncated for MCP text response]`;
}

function parseGoModRequires(goMod: string, maxModules: number): ModuleRef[] {
  const result: ModuleRef[] = [];
  let inBlock = false;
  for (const rawLine of goMod.split(/\r?\n/)) {
    let line = rawLine.replace(/\/\/.*$/, "").trim();
    if (!line) continue;
    if (line === "require (") { inBlock = true; continue; }
    if (inBlock && line === ")") { inBlock = false; continue; }
    if (line.startsWith("require ")) line = line.slice("require ".length).trim();
    else if (!inBlock) continue;
    const parts = line.split(/\s+/);
    if (parts.length >= 2) result.push({ module: parts[0], version: parts[1], indirect: parts.includes("indirect") });
    if (result.length >= maxModules) break;
  }
  return result;
}

function assertSafeIdentifier(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (!trimmed || !/^[A-Za-z0-9._+-]+$/.test(trimmed)) throw new Error(`invalid ${fieldName}`);
  return trimmed;
}

function normalizeGoVersion(raw: string): string {
  const value = assertSafeIdentifier(raw, "Go version");
  return value.startsWith("go") ? value : `go${value}`;
}

function normalizeVTag(raw: string): string {
  const value = assertSafeIdentifier(raw, "version");
  return value.startsWith("v") ? value : `v${value}`;
}

function stripPrefix(raw: string, prefix: string): string {
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
}

function normalizeOS(raw: string): string {
  const value = raw.toLowerCase().trim();
  if (["linux", "darwin", "windows", "freebsd"].includes(value)) return value;
  if (["mac", "macos", "osx"].includes(value)) return "darwin";
  if (["win", "win32", "win64"].includes(value)) return "windows";
  throw new Error(`unsupported os: ${raw}`);
}

function normalizeArch(raw: string): string {
  const value = raw.toLowerCase().trim();
  if (["amd64", "x86_64", "x64"].includes(value)) return "amd64";
  if (["arm64", "aarch64", "aarch_64"].includes(value)) return "arm64";
  if (["386", "x86", "x86_32", "i386"].includes(value)) return "386";
  if (["ppc64le", "ppcle_64"].includes(value)) return "ppc64le";
  if (["s390x", "s390_64"].includes(value)) return "s390x";
  throw new Error(`unsupported arch: ${raw}`);
}

function downloadToolAllowed(tool: ToolName, env: Env): boolean {
  const allow = splitCsv(env.DOWNLOAD_ALLOW_TOOLS).map((v) => v.toLowerCase());
  return allow.length === 0 || allow.includes(tool);
}

async function latestGoVersion(env: Env): Promise<string> {
  if (env.DEFAULT_GO_VERSION) return normalizeGoVersion(env.DEFAULT_GO_VERSION);
  try {
    const response = await fetch("https://go.dev/dl/?mode=json", { headers: { "user-agent": "aisphere-mcp-server-go" }, cf: { cacheEverything: true, cacheTtl: 3600 } });
    if (response.ok) {
      const releases = (await response.json()) as Array<{ version?: string }>;
      const version = releases.find((release) => release.version)?.version;
      if (version) return normalizeGoVersion(version);
    }
  } catch {}
  return CURRENT_SAFE_GO_VERSION;
}

async function latestGithubTag(repo: "bufbuild/buf" | "protocolbuffers/protobuf", fallback: string): Promise<string> {
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "aisphere-mcp-server-go" },
      cf: { cacheEverything: true, cacheTtl: 3600 },
    });
    if (response.ok) {
      const body = (await response.json()) as { tag_name?: string };
      if (body.tag_name) return normalizeVTag(body.tag_name);
    }
  } catch {}
  return normalizeVTag(fallback);
}

async function resolveToolVersion(tool: ToolName, rawVersion: string | undefined, env: Env): Promise<string> {
  const requested = rawVersion?.trim() || "latest";
  if (tool === "go") return requested === "latest" ? latestGoVersion(env) : normalizeGoVersion(requested);
  if (tool === "buf") return requested === "latest" ? latestGithubTag("bufbuild/buf", env.DEFAULT_BUF_VERSION || CURRENT_SAFE_BUF_VERSION) : normalizeVTag(requested);
  if (requested === "latest") return stripPrefix(await latestGithubTag("protocolbuffers/protobuf", env.DEFAULT_PROTOC_VERSION || CURRENT_SAFE_PROTOC_VERSION), "v");
  return stripPrefix(normalizeVTag(requested), "v");
}

function titleOSForBuf(os: string): string {
  if (os === "linux") return "Linux";
  if (os === "darwin") return "Darwin";
  if (os === "windows") return "Windows";
  if (os === "freebsd") return "FreeBSD";
  throw new Error(`unsupported buf os: ${os}`);
}

function archForBuf(arch: string): string {
  if (arch === "amd64") return "x86_64";
  if (arch === "arm64") return "aarch64";
  throw new Error(`unsupported buf arch: ${arch}`);
}

function osForProtoc(os: string): string {
  if (os === "linux") return "linux";
  if (os === "darwin") return "osx";
  if (os === "windows") return "win64";
  throw new Error(`unsupported protoc os: ${os}`);
}

function archForProtoc(os: string, arch: string): string {
  if (os === "windows") {
    if (arch === "amd64") return "x86_64";
    if (arch === "386") return "x86_32";
    throw new Error(`unsupported protoc windows arch: ${arch}`);
  }
  if (arch === "amd64") return "x86_64";
  if (arch === "arm64") return "aarch_64";
  if (arch === "386") return "x86_32";
  if (arch === "ppc64le") return "ppcle_64";
  if (arch === "s390x") return "s390_64";
  throw new Error(`unsupported protoc arch: ${arch}`);
}

async function buildDownloadSpec(tool: ToolName, rawVersion: string | undefined, rawOS: string, rawArch: string, env: Env, archive = true): Promise<DownloadSpec> {
  if (!downloadToolAllowed(tool, env)) throw new Error(`download tool is not allowed: ${tool}`);
  const os = normalizeOS(rawOS);
  const arch = normalizeArch(rawArch);
  const version = await resolveToolVersion(tool, rawVersion, env);
  if (tool === "go") {
    const ext = os === "windows" ? "zip" : "tar.gz";
    const filename = `${version}.${os}-${arch}.${ext}`;
    return { tool, version, os, arch, filename, upstreamUrl: `https://go.dev/dl/${filename}`, contentType: ext === "zip" ? "application/zip" : "application/gzip", notes: ["Go archive from go.dev downloads."] };
  }
  if (tool === "buf") {
    const filename = `buf-${titleOSForBuf(os)}-${archForBuf(arch)}${archive ? ".tar.gz" : os === "windows" ? ".exe" : ""}`;
    return { tool, version, os, arch, filename, upstreamUrl: `https://github.com/bufbuild/buf/releases/download/${version}/${filename}`, contentType: archive ? "application/gzip" : "application/octet-stream", notes: [archive ? "buf tar.gz release asset." : "buf raw binary release asset."] };
  }
  const protocVersion = stripPrefix(version, "v");
  const filename = `protoc-${protocVersion}-${osForProtoc(os)}-${archForProtoc(os, arch)}.zip`;
  return { tool, version: protocVersion, os, arch, filename, upstreamUrl: `https://github.com/protocolbuffers/protobuf/releases/download/v${protocVersion}/${filename}`, contentType: "application/zip", notes: ["Protocol Buffers protoc release zip."] };
}

function parseDownloadPath(suffix: string): { tool: ToolName; version: string; os: string; arch: string } {
  const parts = suffix.replace(/^\/+/, "").split("/").filter(Boolean);
  if (parts.length !== 4) throw new Error("download path must be /download[/token]/{go|buf|protoc}/{version|latest}/{os}/{arch}");
  const [tool, version, os, arch] = parts;
  if (tool !== "go" && tool !== "buf" && tool !== "protoc") throw new Error(`unsupported download tool: ${tool}`);
  return { tool, version, os, arch };
}

async function fetchDownloadSpec(spec: DownloadSpec, request?: Request): Promise<Response> {
  const headers = new Headers();
  for (const name of ["user-agent", "range", "if-none-match"] as const) {
    const value = request?.headers.get(name);
    if (value) headers.set(name, value);
  }
  return fetch(spec.upstreamUrl, {
    method: request?.method === "HEAD" ? "HEAD" : "GET",
    headers,
    redirect: "follow",
    cf: { cacheEverything: true, cacheTtlByStatus: { "200-299": 86400, "300-399": 3600, "404": 300, "500-599": 0 } },
  });
}

async function handleDownload(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return corsOptions("GET, HEAD, OPTIONS", "authorization, x-download-token, x-proxy-token, range, content-type");
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("method not allowed", { status: 405 });
  const url = new URL(request.url);
  const auth = pathTokenAuth(request, downloadToken(env), url.pathname.slice("/download".length) || "/", ["x-download-token", "x-proxy-token"]);
  if (!auth.ok || !auth.suffix) return new Response("unauthorized", { status: 401 });
  const { tool, version, os, arch } = parseDownloadPath(auth.suffix);
  const spec = await buildDownloadSpec(tool, version, os, arch, env, url.searchParams.get("archive") !== "0");
  const upstream = await fetchDownloadSpec(spec, request);
  const headers = new Headers(upstream.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("x-aisphere-mcp-server", "mcp-server-go");
  headers.set("x-aisphere-download-tool", spec.tool);
  headers.set("x-aisphere-download-version", spec.version);
  headers.set("x-aisphere-upstream", spec.upstreamUrl);
  headers.set("content-disposition", `attachment; filename=\"${spec.filename}\"`);
  if (!headers.has("content-type")) headers.set("content-type", spec.contentType);
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
}

function downloadUrl(origin: string, env: Env, spec: DownloadSpec): string {
  return `${downloadBaseUrl(origin, env)}/${spec.tool}/${encodeURIComponent(spec.version)}/${spec.os}/${spec.arch}`;
}

function repoAllowed(ref: RepoRef, env: Env): boolean {
  const repoFull = `${ref.owner}/${ref.repo}`.toLowerCase();
  const owners = splitCsv(env.GITHUB_ALLOW_OWNERS).map((v) => v.toLowerCase());
  const repos = splitCsv(env.GITHUB_ALLOW_REPOS).map((v) => v.toLowerCase());
  if (repos.length > 0) return repos.includes(repoFull);
  if (owners.length > 0) return owners.includes(ref.owner.toLowerCase());
  return true;
}

function assertRepoPart(value: string, fieldName: string): string {
  const decoded = decodeURIComponent(value.trim()).replace(/\.git$/i, "");
  if (!decoded || !/^[A-Za-z0-9_.-]+$/.test(decoded)) throw new Error(`invalid GitHub ${fieldName}`);
  return decoded;
}

function parseGithubRepo(input: string): RepoRef {
  const raw = input.trim();
  let path = raw;
  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    if (url.hostname !== "github.com" && url.hostname !== "www.github.com") throw new Error("only github.com repository URLs are supported");
    path = url.pathname;
  }
  const parts = path.replace(/^\/+/, "").split("/").filter(Boolean);
  if (parts.length < 2) throw new Error("repository must be owner/repo or https://github.com/owner/repo");
  return { owner: assertRepoPart(parts[0], "owner"), repo: assertRepoPart(parts[1], "repo") };
}

function parseGitPath(suffix: string): { repo: RepoRef; upstreamPath: string } {
  const clean = suffix.replace(/^\/+/, "");
  const parts = clean.split("/");
  if (parts.length < 2) throw new Error("git path must be /git[/token]/{owner}/{repo}.git[/...] ");
  const owner = assertRepoPart(parts[0], "owner");
  const repo = assertRepoPart(parts[1], "repo");
  const rest = parts.slice(2).join("/");
  return { repo: { owner, repo }, upstreamPath: rest ? `/${rest}` : "" };
}

function archiveFormat(value: string): ArchiveFormat {
  const lowered = value.toLowerCase();
  if (lowered === "zip") return "zip";
  if (lowered === "tar.gz" || lowered === "tgz" || lowered === "tarball") return "tar.gz";
  throw new Error("archive format must be zip or tar.gz");
}

function assertRef(value: string): string {
  const decoded = decodeURIComponent(value.trim());
  if (!decoded || decoded.includes("..") || decoded.includes("\\") || decoded.startsWith("/") || decoded.length > 200) throw new Error("invalid GitHub ref");
  return decoded;
}

function githubArchiveUrl(repo: RepoRef, ref: string, format: ArchiveFormat): string {
  return `https://codeload.github.com/${repo.owner}/${repo.repo}/${format}/${encodeURIComponent(ref)}`;
}

function githubArchiveCloudflareUrl(origin: string, env: Env, repo: RepoRef, ref: string, format: ArchiveFormat): string {
  return `${githubBaseUrl(origin, env)}/archive/${repo.owner}/${repo.repo}/${encodeURIComponent(ref)}/${format === "tar.gz" ? "tar.gz" : "zip"}`;
}

function gitCloneUrl(origin: string, env: Env, repo: RepoRef): string {
  return `${gitBaseUrl(origin, env)}/${repo.owner}/${repo.repo}.git`;
}

function githubAuthHeaders(env: Env): Headers {
  const headers = new Headers();
  if (env.GITHUB_TOKEN) headers.set("authorization", `Bearer ${env.GITHUB_TOKEN}`);
  headers.set("user-agent", "aisphere-mcp-server-go");
  return headers;
}

async function handleGithubGitProxy(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return corsOptions("GET, HEAD, POST, OPTIONS", "authorization, x-github-token, x-proxy-token, content-type, git-protocol");
  if (!["GET", "HEAD", "POST"].includes(request.method)) return new Response("method not allowed", { status: 405 });
  const url = new URL(request.url);
  const auth = pathTokenAuth(request, githubToken(env), url.pathname.slice("/git".length) || "/", ["x-github-token", "x-proxy-token"]);
  if (!auth.ok || !auth.suffix) return new Response("unauthorized", { status: 401 });
  const parsed = parseGitPath(auth.suffix);
  if (!repoAllowed(parsed.repo, env)) return new Response("GitHub repo is not allowed", { status: 403 });
  const upstreamUrl = `https://github.com/${parsed.repo.owner}/${parsed.repo.repo}.git${parsed.upstreamPath}${url.search}`;
  const headers = githubAuthHeaders(env);
  for (const name of ["accept", "accept-language", "content-type", "git-protocol", "user-agent"] as const) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const init: RequestInit = { method: request.method, headers, redirect: "follow" };
  if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;
  const upstream = await fetch(upstreamUrl, init);
  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.set("access-control-allow-origin", "*");
  responseHeaders.set("x-aisphere-mcp-server", "mcp-server-go");
  responseHeaders.set("x-aisphere-github-upstream", upstreamUrl.replace(url.search, ""));
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
}

async function handleGithubArchive(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return corsOptions("GET, HEAD, OPTIONS", "authorization, x-github-token, x-proxy-token, range, content-type");
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("method not allowed", { status: 405 });
  const url = new URL(request.url);
  const auth = pathTokenAuth(request, githubToken(env), url.pathname.slice("/github".length) || "/", ["x-github-token", "x-proxy-token"]);
  if (!auth.ok || !auth.suffix) return new Response("unauthorized", { status: 401 });
  const parts = auth.suffix.replace(/^\/+/, "").split("/").filter(Boolean);
  if (parts[0] !== "archive" || parts.length !== 5) throw new Error("github archive path must be /github[/token]/archive/{owner}/{repo}/{ref}/{zip|tar.gz}");
  const repo = { owner: assertRepoPart(parts[1], "owner"), repo: assertRepoPart(parts[2], "repo") };
  if (!repoAllowed(repo, env)) return new Response("GitHub repo is not allowed", { status: 403 });
  const ref = assertRef(parts[3]);
  const format = archiveFormat(parts[4]);
  const upstreamUrl = githubArchiveUrl(repo, ref, format);
  const headers = githubAuthHeaders(env);
  for (const name of ["range", "if-none-match", "user-agent"] as const) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const upstream = await fetch(upstreamUrl, { method: request.method, headers, redirect: "follow", cf: { cacheEverything: true, cacheTtlByStatus: { "200-299": 3600, "300-399": 300, "404": 300, "500-599": 0 } } });
  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.set("access-control-allow-origin", "*");
  responseHeaders.set("x-aisphere-mcp-server", "mcp-server-go");
  responseHeaders.set("x-aisphere-github-upstream", upstreamUrl);
  responseHeaders.set("content-disposition", `attachment; filename=\"${repo.repo}-${ref.replace(/[^A-Za-z0-9_.-]/g, "-")}.${format}\"`);
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
}

async function preflightGithubRepo(repo: RepoRef, env: Env): Promise<Record<string, unknown>> {
  if (!repoAllowed(repo, env)) return { ok: false, status: 403, error: "GitHub repo is not allowed" };
  const apiResponse = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}`, { headers: githubAuthHeaders(env), cf: { cacheEverything: true, cacheTtl: 300 } });
  const refsResponse = await fetch(`https://github.com/${repo.owner}/${repo.repo}.git/info/refs?service=git-upload-pack`, { headers: githubAuthHeaders(env), cf: { cacheEverything: true, cacheTtl: 300 } });
  return {
    ok: apiResponse.ok && refsResponse.ok,
    repo: `${repo.owner}/${repo.repo}`,
    apiStatus: apiResponse.status,
    gitInfoRefsStatus: refsResponse.status,
    privateTokenConfigured: Boolean(env.GITHUB_TOKEN),
  };
}

function installCommands(spec: DownloadSpec, url: string, shell: ShellName): string {
  if (shell === "powershell") {
    if (spec.tool === "go") return [`$url = \"${url}\"`, `$out = Join-Path $PWD \"${spec.filename}\"`, `Invoke-WebRequest -Uri $url -OutFile $out`, `Expand-Archive -Force $out -DestinationPath .\\tools`, `$env:Path = \"$PWD\\tools\\go\\bin;$env:Path\"`, `go version`].join("\n");
    if (spec.tool === "buf") return [`$url = \"${url}\"`, `$out = Join-Path $PWD \"${spec.filename}\"`, `Invoke-WebRequest -Uri $url -OutFile $out`, `New-Item -ItemType Directory -Force .\\tools\\buf | Out-Null`, `tar -xzf $out -C .\\tools\\buf`, `$env:Path = \"$PWD\\tools\\buf;$env:Path\"`, `buf --version`].join("\n");
    return [`$url = \"${url}\"`, `$out = Join-Path $PWD \"${spec.filename}\"`, `Invoke-WebRequest -Uri $url -OutFile $out`, `Expand-Archive -Force $out -DestinationPath .\\tools\\protoc`, `$env:Path = \"$PWD\\tools\\protoc\\bin;$env:Path\"`, `protoc --version`].join("\n");
  }
  if (spec.tool === "go") return [`curl -L -o /tmp/${spec.filename} \"${url}\"`, `sudo rm -rf /usr/local/go`, `sudo tar -C /usr/local -xzf /tmp/${spec.filename}`, `export PATH=\"/usr/local/go/bin:$PATH\"`, `go version`].join("\n");
  if (spec.tool === "buf") return [`curl -L -o /tmp/${spec.filename} \"${url}\"`, `tmpdir=$(mktemp -d)`, `tar -xzf /tmp/${spec.filename} -C \"$tmpdir\"`, `mkdir -p \"$HOME/.local/bin\"`, `find \"$tmpdir\" -type f -name buf -exec install -m 0755 {} \"$HOME/.local/bin/buf\" \\; -quit`, `export PATH=\"$HOME/.local/bin:$PATH\"`, `buf --version`].join("\n");
  return [`curl -L -o /tmp/${spec.filename} \"${url}\"`, `mkdir -p \"$HOME/.local/protoc\"`, `unzip -o /tmp/${spec.filename} -d \"$HOME/.local/protoc\"`, `export PATH=\"$HOME/.local/protoc/bin:$PATH\"`, `protoc --version`].join("\n");
}

function repoCommands(repo: RepoRef, cloneUrl: string, archiveUrl: string, ref: string, mode: "git" | "archive", shell: ShellName): string {
  if (shell === "powershell") {
    if (mode === "archive") return [`$url = \"${archiveUrl}\"`, `$out = Join-Path $PWD \"${repo.repo}-${ref}.zip\"`, `Invoke-WebRequest -Uri $url -OutFile $out`, `Expand-Archive -Force $out -DestinationPath .\\${repo.repo}`].join("\n");
    return [`$repo = \"${repo.repo}\"`, `if (Test-Path $repo) { git -C $repo pull --ff-only } else { git clone \"${cloneUrl}\" $repo }`].join("\n");
  }
  if (mode === "archive") return [`curl -L -o /tmp/${repo.repo}-${ref}.zip \"${archiveUrl}\"`, `rm -rf \"${repo.repo}\"`, `mkdir -p \"${repo.repo}\"`, `unzip -o /tmp/${repo.repo}-${ref}.zip -d \"${repo.repo}\"`].join("\n");
  return [`if [ -d \"${repo.repo}/.git\" ]; then`, `  git -C \"${repo.repo}\" pull --ff-only`, `else`, `  git clone \"${cloneUrl}\" \"${repo.repo}\"`, `fi`].join("\n");
}

function corsOptions(methods: string, headers: string): Response {
  return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": methods, "access-control-allow-headers": headers } });
}

function createServer(origin: string, env: Env) {
  const server = new McpServer({ name: "aisphere-go-network-bridge", version: "0.3.0" });

  server.registerTool("go_proxy_config", { description: "Return GOPROXY commands that route Go module downloads through this Cloudflare server.", inputSchema: { shell: z.enum(["bash", "powershell"]).default("bash") } }, async ({ shell }) => {
    const base = proxyBaseUrl(origin, env);
    const cmd = shell === "powershell" ? `$env:GOPROXY=\"${base},direct\"\n$env:GOSUMDB=\"sum.golang.org\"\ngo env GOPROXY GOSUMDB\ngo mod tidy` : `export GOPROXY=\"${base},direct\"\nexport GOSUMDB=\"sum.golang.org\"\ngo env GOPROXY GOSUMDB\ngo mod tidy`;
    return textContent(["Use this in an environment that can reach Cloudflare but cannot reach proxy.golang.org directly:", "", cmd, "", "This is a Go module proxy bridge, not a generic TCP/HTTP CONNECT proxy."].join("\n"));
  });

  server.registerTool("go_proxy_fetch", { description: "Fetch a small Go module proxy artifact through the configured upstream Go proxy. Do not use this for large .zip bodies.", inputSchema: { module: z.string().min(1), artifact: z.enum(["list", "latest", "mod", "info", "zip"]).default("latest"), version: z.string().optional() } }, async ({ module, artifact, version }) => {
    const suffix = buildGoProxySuffix(module, artifact, version);
    const response = await fetchGoProxySuffix(suffix, env);
    const body = artifact === "zip" ? "[zip body omitted; use GOPROXY /proxy endpoint to stream it]" : await readSmallText(response);
    return textContent(JSON.stringify({ module, artifact, version, status: response.status, contentType: response.headers.get("content-type"), upstream: normalizeUpstream(env.UPSTREAM_GOPROXY), proxyPath: suffix, body }, null, 2));
  });

  server.registerTool("go_mod_preflight", { description: "Parse a go.mod file and check whether direct require entries are reachable via the upstream Go proxy.", inputSchema: { goMod: z.string().min(1), maxModules: z.number().int().min(1).max(100).default(30) } }, async ({ goMod, maxModules }) => {
    const checks: Array<Record<string, unknown>> = [];
    for (const ref of parseGoModRequires(goMod, maxModules)) {
      const suffix = buildGoProxySuffix(ref.module, "mod", ref.version);
      const response = await fetchGoProxySuffix(suffix, env);
      checks.push({ module: ref.module, version: ref.version, indirect: ref.indirect, status: response.status, ok: response.ok, proxyPath: suffix });
    }
    return textContent(JSON.stringify({ upstream: normalizeUpstream(env.UPSTREAM_GOPROXY), proxyBase: proxyBaseUrl(origin, env), checked: checks.length, checks, note: "This preflight checks declared require entries only. go mod tidy still needs the Go tool locally to resolve imports, tests, and transitive requirements." }, null, 2));
  });

  server.registerTool("tool_download_config", { description: "Generate Cloudflare download URLs and install commands for go, buf, or protoc binary tools.", inputSchema: { tool: z.enum(["go", "buf", "protoc"]), version: z.string().optional(), os: z.string().default("linux"), arch: z.string().default("amd64"), shell: z.enum(["bash", "powershell"]).default("bash"), archive: z.boolean().default(true) } }, async ({ tool, version, os, arch, shell, archive }) => {
    const spec = await buildDownloadSpec(tool, version, os, arch, env, archive);
    const url = downloadUrl(origin, env, spec);
    return textContent(JSON.stringify({ ...spec, cloudflareUrl: url, command: installCommands(spec, url, shell) }, null, 2));
  });

  server.registerTool("tool_download_preflight", { description: "HEAD-check the upstream binary artifact for go, buf, or protoc.", inputSchema: { tool: z.enum(["go", "buf", "protoc"]), version: z.string().optional(), os: z.string().default("linux"), arch: z.string().default("amd64"), archive: z.boolean().default(true) } }, async ({ tool, version, os, arch, archive }) => {
    const spec = await buildDownloadSpec(tool, version, os, arch, env, archive);
    const response = await fetchDownloadSpec(spec, new Request(spec.upstreamUrl, { method: "HEAD" }));
    return textContent(JSON.stringify({ ...spec, cloudflareUrl: downloadUrl(origin, env, spec), status: response.status, ok: response.ok, contentLength: response.headers.get("content-length"), contentType: response.headers.get("content-type"), etag: response.headers.get("etag"), lastModified: response.headers.get("last-modified") }, null, 2));
  });

  server.registerTool("tool_download_bundle_manifest", { description: "Return a manifest and install commands for a standard Go dev toolchain: Go, buf, and protoc.", inputSchema: { os: z.string().default("linux"), arch: z.string().default("amd64"), goVersion: z.string().optional(), bufVersion: z.string().optional(), protocVersion: z.string().optional(), shell: z.enum(["bash", "powershell"]).default("bash") } }, async ({ os, arch, goVersion, bufVersion, protocVersion, shell }) => {
    const specs = [await buildDownloadSpec("go", goVersion, os, arch, env, true), await buildDownloadSpec("buf", bufVersion, os, arch, env, true), await buildDownloadSpec("protoc", protocVersion, os, arch, env, true)];
    return textContent(JSON.stringify({ downloadBase: downloadBaseUrl(origin, env), tools: specs.map((spec) => ({ ...spec, cloudflareUrl: downloadUrl(origin, env, spec), command: installCommands(spec, downloadUrl(origin, env, spec), shell) })) }, null, 2));
  });

  server.registerTool("github_repo_config", { description: "Generate git clone/pull or archive download commands for a GitHub repository through Cloudflare.", inputSchema: { repository: z.string().min(1).describe("owner/repo or https://github.com/owner/repo"), ref: z.string().default("main"), mode: z.enum(["git", "archive"]).default("git"), shell: z.enum(["bash", "powershell"]).default("bash"), archiveFormat: z.enum(["zip", "tar.gz"]).default("zip") } }, async ({ repository, ref, mode, shell, archiveFormat }) => {
    const repo = parseGithubRepo(repository);
    if (!repoAllowed(repo, env)) throw new Error("GitHub repo is not allowed");
    const safeRef = assertRef(ref);
    const format = archiveFormat as ArchiveFormat;
    const cloneUrl = gitCloneUrl(origin, env, repo);
    const archiveUrl = githubArchiveCloudflareUrl(origin, env, repo, safeRef, format);
    return textContent(JSON.stringify({ repo: `${repo.owner}/${repo.repo}`, mode, ref: safeRef, cloneUrl, archiveUrl, command: repoCommands(repo, cloneUrl, archiveUrl, safeRef, mode, shell), note: "Cloudflare proxies GitHub HTTPS smart protocol and archive downloads; it does not run git itself." }, null, 2));
  });

  server.registerTool("github_repo_preflight", { description: "Check whether a GitHub repository is reachable through GitHub API and git info/refs.", inputSchema: { repository: z.string().min(1) } }, async ({ repository }) => {
    const repo = parseGithubRepo(repository);
    return textContent(JSON.stringify(await preflightGithubRepo(repo, env), null, 2));
  });

  return server;
}

function landing(origin: string, env: Env): Response {
  const lines = [
    "aisphere mcp-server-go",
    "",
    "Endpoints:",
    `- MCP: ${origin}/mcp`,
    `- Go proxy: ${proxyBaseUrl(origin, env)}`,
    `- Binary downloads: ${downloadBaseUrl(origin, env)}/{go|buf|protoc}/{version|latest}/{os}/{arch}`,
    `- Git HTTPS proxy: ${gitBaseUrl(origin, env)}/{owner}/{repo}.git`,
    `- GitHub archive: ${githubBaseUrl(origin, env)}/archive/{owner}/{repo}/{ref}/{zip|tar.gz}`,
    `- Health: ${origin}/health`,
    "",
    "Examples:",
    `export GOPROXY=\"${proxyBaseUrl(origin, env)},direct\"`,
    `curl -L -o go.tar.gz ${downloadBaseUrl(origin, env)}/go/latest/linux/amd64`,
    `git clone ${gitBaseUrl(origin, env)}/aisphereio/kernel.git`,
    `curl -L -o repo.zip ${githubBaseUrl(origin, env)}/archive/aisphereio/kernel/main/zip`,
    "",
    `Upstream Go proxy: ${normalizeUpstream(env.UPSTREAM_GOPROXY)}`,
  ];
  return new Response(lines.join("\n"), { headers: { "content-type": "text/plain; charset=utf-8" } });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/health") return jsonResponse({ ok: true, service: "mcp-server-go", mcp: `${url.origin}/mcp`, proxy: proxyBaseUrl(url.origin, env), download: downloadBaseUrl(url.origin, env), git: gitBaseUrl(url.origin, env), github: githubBaseUrl(url.origin, env), upstream: normalizeUpstream(env.UPSTREAM_GOPROXY), tools: ["go", "buf", "protoc", "github"] });
      if (url.pathname === "/" || url.pathname === "/index.html") return landing(url.origin, env);
      if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
        if (!isMcpAuthorized(request, env)) return new Response("unauthorized", { status: 401, headers: { "www-authenticate": "Bearer" } });
        return createMcpHandler(createServer(url.origin, env))(request, env, ctx);
      }
      if (url.pathname === "/proxy" || url.pathname.startsWith("/proxy/")) return handleGoProxy(request, env);
      if (url.pathname === "/download" || url.pathname.startsWith("/download/")) return handleDownload(request, env);
      if (url.pathname === "/git" || url.pathname.startsWith("/git/")) return handleGithubGitProxy(request, env);
      if (url.pathname === "/github" || url.pathname.startsWith("/github/")) return handleGithubArchive(request, env);
      return jsonResponse({ error: "not_found", mcp: `${url.origin}/mcp`, proxy: proxyBaseUrl(url.origin, env), download: downloadBaseUrl(url.origin, env), git: gitBaseUrl(url.origin, env), github: githubBaseUrl(url.origin, env) }, 404);
    } catch (error) {
      return errorResponse(error, 400);
    }
  },
} satisfies ExportedHandler<Env>;
