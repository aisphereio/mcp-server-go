# mcp-server-go

Cloudflare Workers / Cloudflare Pages Functions based MCP server for Go development in restricted network environments.

It exposes five things:

1. `GET /proxy/...` — Go module proxy bridge. Set `GOPROXY` to this endpoint and run `go mod tidy` locally, in Codespaces, or in another sandbox that can reach Cloudflare.
2. `GET /download/...` — binary download bridge for Go, buf, and protoc release artifacts.
3. `GET|POST /git/...` — GitHub HTTPS smart-protocol proxy for public GitHub repositories, and optionally private repositories if `GITHUB_TOKEN` is configured.
4. `GET /github/archive/...` — GitHub repository archive download bridge for zip or tar.gz source packages.
5. `POST /mcp` — remote MCP endpoint with tools for Go module proxy config, binary tool downloads, and GitHub repo clone/archive command generation.

This is not a generic TCP proxy and it does not run `git`, `go`, or the compiler inside Cloudflare. Cloudflare only streams HTTP requests to upstream services such as `proxy.golang.org`, `go.dev`, GitHub Releases, and GitHub HTTPS Git endpoints.

## Architecture

```text
ChatGPT / MCP client
        |
        | Streamable HTTP MCP
        v
Cloudflare /mcp -------------- tools: go_proxy_config, go_mod_preflight,
        |                         tool_download_config, github_repo_config,
        |                         github_repo_preflight, ...
        |
        +-> /proxy/* ------------ streams Go module proxy protocol
        |                          -> https://proxy.golang.org
        |
        +-> /download/* --------- streams Go / buf / protoc binaries
        |                          -> go.dev / GitHub Releases
        |
        +-> /git/* -------------- proxies GitHub HTTPS smart protocol
        |                          -> https://github.com/{owner}/{repo}.git
        |
        +-> /github/archive/* --- streams repository zip/tar.gz archives
                                   -> https://codeload.github.com
```

## Deploy as a Worker

```bash
npm install
npm run typecheck
npx wrangler login
npm run deploy
```

After deploy, you will get a URL like:

```text
https://mcp-server-go.<your-account>.workers.dev
```

## Deploy as Cloudflare Pages

Cloudflare Pages Functions can run the same handler through `functions/_middleware.ts`.

Manual deploy:

```bash
npm install
npm run typecheck
npx wrangler pages project create mcp-server-go
npm run pages:deploy
```

Or connect this GitHub repository in the Cloudflare dashboard:

- Framework preset: `None`
- Build command: `npm run build`
- Build output directory: `public`
- Environment variable: `NODE_VERSION=22`

## Runtime variables

Add these in Worker / Pages `Settings -> Variables & Secrets`.

| Variable | Required | Purpose |
| --- | --- | --- |
| `UPSTREAM_GOPROXY` | No | Default is `https://proxy.golang.org`. |
| `PROXY_TOKEN` | Recommended | Protects `/proxy`; also used by `/download` and `/git` when their own tokens are not set. |
| `DOWNLOAD_TOKEN` | No | If set, binary download URL becomes `/download/<token>/...`. |
| `GITHUB_PROXY_TOKEN` | No | If set, GitHub proxy URL becomes `/git/<token>/...` and `/github/<token>/archive/...`. |
| `MCP_BEARER_TOKEN` | No | If set, `/mcp` requires `Authorization: Bearer <token>`. |
| `ALLOW_MODULE_PREFIXES` | No | Comma-separated Go module allowlist, for example `github.com/aisphereio/`. |
| `BLOCK_MODULE_PREFIXES` | No | Comma-separated Go module blocklist. |
| `DOWNLOAD_ALLOW_TOOLS` | No | Comma-separated tool allowlist. Default allows `go,buf,protoc`. |
| `DEFAULT_GO_VERSION` | No | Used when `/download/go/latest/...` cannot query go.dev. Example: `go1.26.4`. |
| `DEFAULT_BUF_VERSION` | No | Used when `/download/buf/latest/...` cannot query GitHub. Example: `v1.71.0`. |
| `DEFAULT_PROTOC_VERSION` | No | Used when `/download/protoc/latest/...` cannot query GitHub. Example: `35.1`. |
| `GITHUB_ALLOW_OWNERS` | No | Comma-separated GitHub owner allowlist, for example `aisphereio`. |
| `GITHUB_ALLOW_REPOS` | No | Comma-separated repo allowlist, for example `aisphereio/kernel,aisphereio/mcp-server-go`. Takes priority over owner allowlist. |
| `GITHUB_TOKEN` | No | Optional GitHub token forwarded only to GitHub upstream. Use only if you need private repo read access. Store as a secret. |

Recommended public-repo setup:

```text
PROXY_TOKEN=<long-random-token>
DOWNLOAD_TOKEN=<long-random-token>
GITHUB_PROXY_TOKEN=<long-random-token>
DOWNLOAD_ALLOW_TOOLS=go,buf,protoc
GITHUB_ALLOW_OWNERS=aisphereio
DEFAULT_GO_VERSION=go1.26.4
DEFAULT_BUF_VERSION=v1.71.0
DEFAULT_PROTOC_VERSION=35.1
```

## Go module proxy

Without token:

```bash
export GOPROXY="https://<your-domain>/proxy,direct"
export GOSUMDB="sum.golang.org"
go mod tidy
```

With `PROXY_TOKEN=abc123`:

```bash
export GOPROXY="https://<your-domain>/proxy/abc123,direct"
go mod tidy
```

## Binary download bridge

URL shape:

```text
/download[/token]/{tool}/{version|latest}/{os}/{arch}
```

Examples:

```bash
curl -L -o /tmp/go.tar.gz https://<your-domain>/download/abc123/go/latest/linux/amd64
curl -L -o /tmp/buf.tar.gz https://<your-domain>/download/abc123/buf/latest/linux/amd64
curl -L -o /tmp/protoc.zip https://<your-domain>/download/abc123/protoc/latest/linux/amd64
```

## GitHub repository bridge

There are two modes.

### Mode A: Git HTTPS proxy

URL shape:

```text
/git[/token]/{owner}/{repo}.git
```

Example with `GITHUB_PROXY_TOKEN=git123`:

```bash
git clone https://<your-domain>/git/git123/aisphereio/kernel.git
cd kernel
git pull --ff-only
```

This proxies the GitHub HTTPS smart protocol to:

```text
https://github.com/aisphereio/kernel.git
```

It can support normal `git clone`, `git fetch`, and `git pull` as long as the client can reach your Cloudflare domain and GitHub accepts the upstream request.

### Mode B: Repository archive download

URL shape:

```text
/github[/token]/archive/{owner}/{repo}/{ref}/{zip|tar.gz}
```

Examples:

```bash
curl -L -o kernel.zip https://<your-domain>/github/git123/archive/aisphereio/kernel/main/zip
curl -L -o kernel.tar.gz https://<your-domain>/github/git123/archive/aisphereio/kernel/main/tar.gz
```

Archive mode is usually more reliable for restricted environments because it is a single HTTP download. Git mode is closer to real `git pull`, but depends on Git smart-protocol behavior over HTTP.

## MCP tools

- `go_proxy_config` — returns Bash or PowerShell commands for `GOPROXY` and `go mod tidy`.
- `go_proxy_fetch` — fetches small Go module proxy artifacts such as `@latest`, `.info`, `.mod`, or version list.
- `go_mod_preflight` — parses a provided `go.mod` and checks declared `require` entries against the upstream Go proxy.
- `tool_download_config` — generates a Cloudflare download URL and install command for `go`, `buf`, or `protoc`.
- `tool_download_preflight` — HEAD-checks a resolved upstream binary artifact and returns status, content length, and metadata.
- `tool_download_bundle_manifest` — returns a standard Linux/macOS/Windows toolchain manifest for Go + buf + protoc.
- `github_repo_config` — generates Git clone/pull commands or archive download commands for a GitHub repository URL.
- `github_repo_preflight` — checks GitHub API and `info/refs` reachability for a repository.

Example MCP prompts after connecting this server to ChatGPT:

```text
Use Aisphere Go MCP to generate Linux amd64 install commands for Go, buf, and protoc.
```

```text
Use Aisphere Go MCP to generate git clone/pull commands for https://github.com/aisphereio/kernel.git.
```

```text
Use Aisphere Go MCP to generate an archive download command for https://github.com/aisphereio/kernel.git ref main.
```

## Health and tests

```bash
curl https://<your-domain>/health
```

Go proxy:

```bash
curl https://<your-domain>/proxy/abc123/github.com/gin-gonic/gin/@v/list
```

Binary downloads:

```bash
curl -I https://<your-domain>/download/abc123/go/latest/linux/amd64
curl -I https://<your-domain>/download/abc123/buf/latest/linux/amd64
curl -I https://<your-domain>/download/abc123/protoc/latest/linux/amd64
```

GitHub archive:

```bash
curl -I https://<your-domain>/github/git123/archive/aisphereio/kernel/main/zip
```

Git clone:

```bash
git ls-remote https://<your-domain>/git/git123/aisphereio/kernel.git
git clone https://<your-domain>/git/git123/aisphereio/kernel.git
```

MCP Inspector:

```bash
npx @modelcontextprotocol/inspector@latest
```

MCP server URL:

```text
https://<your-domain>/mcp
```

## Important limitations

- This cannot make a closed ChatGPT sandbox magically use a system-wide proxy. The sandbox must be able to call your Cloudflare URL, or the MCP client must explicitly call the MCP tools.
- It does not implement HTTP `CONNECT`, SOCKS5, SSH tunneling, arbitrary TCP forwarding, or the SSH Git protocol.
- It cannot run `git pull` inside Cloudflare. It only proxies the GitHub HTTPS requests that a real local `git` command sends.
- For private repositories, configure `GITHUB_TOKEN` only as a Cloudflare secret and protect `/git` and `/github` with `GITHUB_PROXY_TOKEN`. Do not expose this publicly.
- Archive downloads are simpler and more reliable than Git smart-protocol proxying for one-shot source retrieval.

## Recommended next step for aisphere offline builds

Use this project as layer 1:

```text
GOPROXY -> Cloudflare /proxy -> proxy.golang.org
curl    -> Cloudflare /download -> go.dev / GitHub Releases
git     -> Cloudflare /git -> github.com
curl    -> Cloudflare /github/archive -> codeload.github.com
```

For stronger offline development, add layer 2 later:

```text
MCP tool -> GitHub Actions job -> git clone + download Go/buf/protoc + go mod download/vendor -> artifact zip
```

That second layer is the right place to produce deterministic offline bundles for this assistant sandbox or Windows/Linux air-gapped environments.
