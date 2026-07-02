# mcp-server-go

Cloudflare Workers / Cloudflare Pages Functions based MCP server for Go development in restricted network environments.

It exposes three things:

1. `GET /proxy/...` — a Go module proxy bridge. Set `GOPROXY` to this endpoint and run `go mod tidy` locally, in Codespaces, or in another sandbox that can reach Cloudflare.
2. `GET /download/...` — a binary download bridge for Go, buf, and protoc release artifacts.
3. `POST /mcp` — a remote MCP endpoint with tools that can generate Go proxy config, preflight module reachability, and generate binary tool download commands.

This is not a generic TCP proxy and it does not run the Go compiler inside Cloudflare. Cloudflare Workers/Pages Functions are best used here as an HTTP bridge to upstream artifact hosts such as `https://proxy.golang.org`, `https://go.dev/dl`, and GitHub Releases.

## Architecture

```text
ChatGPT / MCP client
        |
        | Streamable HTTP MCP
        v
Cloudflare /mcp -------------- tools: go_proxy_config, go_proxy_fetch, go_mod_preflight,
        |                         tool_download_config, tool_download_preflight,
        |                         tool_download_bundle_manifest
        |
        | normal HTTP Go proxy protocol
        v
Cloudflare /proxy/* ---------- streams to UPSTREAM_GOPROXY
        |
        v
https://proxy.golang.org

curl / wget / Go sandbox
        |
        v
Cloudflare /download/* ------- streams Go / buf / protoc binaries
        |
        +-> https://go.dev/dl/...
        +-> https://github.com/bufbuild/buf/releases/download/...
        +-> https://github.com/protocolbuffers/protobuf/releases/download/...
```

For the actual `go mod tidy` path, the important endpoint is `/proxy`, because the Go tool already knows how to speak the Go module proxy protocol.

For installing missing developer tools such as Go, buf, or protoc, use `/download`.

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

Use:

```bash
export GOPROXY="https://mcp-server-go.<your-account>.workers.dev/proxy,direct"
export GOSUMDB="sum.golang.org"
go mod tidy
```

PowerShell:

```powershell
$env:GOPROXY="https://mcp-server-go.<your-account>.workers.dev/proxy,direct"
$env:GOSUMDB="sum.golang.org"
go mod tidy
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

Then add these optional variables in Pages / Workers settings:

| Variable | Required | Purpose |
| --- | --- | --- |
| `UPSTREAM_GOPROXY` | No | Default is `https://proxy.golang.org`. |
| `PROXY_TOKEN` | No | If set, Go proxy URL becomes `/proxy/<token>`. Also protects `/download` unless `DOWNLOAD_TOKEN` is set. |
| `DOWNLOAD_TOKEN` | No | If set, binary download URL becomes `/download/<token>/...`. |
| `MCP_BEARER_TOKEN` | No | If set, `/mcp` requires `Authorization: Bearer <token>`. |
| `ALLOW_MODULE_PREFIXES` | No | Comma-separated allowlist, for example `github.com/aisphereio/`. |
| `BLOCK_MODULE_PREFIXES` | No | Comma-separated blocklist. |
| `DOWNLOAD_ALLOW_TOOLS` | No | Comma-separated tool allowlist. Default allows `go,buf,protoc`. |
| `DEFAULT_GO_VERSION` | No | Used when `/download/go/latest/...` cannot query go.dev. Example: `go1.26.4`. |
| `DEFAULT_BUF_VERSION` | No | Used when `/download/buf/latest/...` cannot query GitHub. Example: `v1.71.0`. |
| `DEFAULT_PROTOC_VERSION` | No | Used when `/download/protoc/latest/...` cannot query GitHub. Example: `35.1`. |

## Secure proxy and download URLs

If you set `PROXY_TOKEN=abc123`, use this as the Go proxy base:

```bash
export GOPROXY="https://<your-domain>/proxy/abc123,direct"
go mod tidy
```

The same token also protects downloads by default:

```bash
curl -L -o go.tar.gz https://<your-domain>/download/abc123/go/latest/linux/amd64
```

If you set `DOWNLOAD_TOKEN=download123`, downloads use that token instead:

```bash
curl -L -o go.tar.gz https://<your-domain>/download/download123/go/latest/linux/amd64
```

For public modules and public tool binaries this is usually enough. Do not use this to expose private module credentials.

## Binary download bridge

URL shape:

```text
/download[/token]/{tool}/{version|latest}/{os}/{arch}
```

Supported tools:

| Tool | Example | Upstream |
| --- | --- | --- |
| `go` | `/download/go/go1.26.4/linux/amd64` | `https://go.dev/dl/go1.26.4.linux-amd64.tar.gz` |
| `buf` | `/download/buf/v1.71.0/linux/amd64` | `https://github.com/bufbuild/buf/releases/download/v1.71.0/buf-Linux-x86_64.tar.gz` |
| `protoc` | `/download/protoc/35.1/linux/amd64` | `https://github.com/protocolbuffers/protobuf/releases/download/v35.1/protoc-35.1-linux-x86_64.zip` |

Common aliases:

- OS: `linux`, `darwin`, `macos`, `osx`, `windows`
- Arch: `amd64`, `x86_64`, `x64`, `arm64`, `aarch64`, `386`

Linux AMD64 examples:

```bash
curl -L -o /tmp/go.tar.gz https://<your-domain>/download/go/latest/linux/amd64
curl -L -o /tmp/buf.tar.gz https://<your-domain>/download/buf/latest/linux/amd64
curl -L -o /tmp/protoc.zip https://<your-domain>/download/protoc/latest/linux/amd64
```

Install examples:

```bash
# Go
curl -L -o /tmp/go.tar.gz https://<your-domain>/download/go/latest/linux/amd64
sudo rm -rf /usr/local/go
sudo tar -C /usr/local -xzf /tmp/go.tar.gz
export PATH="/usr/local/go/bin:$PATH"
go version

# buf
curl -L -o /tmp/buf.tar.gz https://<your-domain>/download/buf/latest/linux/amd64
tmpdir=$(mktemp -d)
tar -xzf /tmp/buf.tar.gz -C "$tmpdir"
mkdir -p "$HOME/.local/bin"
find "$tmpdir" -type f -name buf -exec install -m 0755 {} "$HOME/.local/bin/buf" \; -quit
export PATH="$HOME/.local/bin:$PATH"
buf --version

# protoc
curl -L -o /tmp/protoc.zip https://<your-domain>/download/protoc/latest/linux/amd64
mkdir -p "$HOME/.local/protoc"
unzip -o /tmp/protoc.zip -d "$HOME/.local/protoc"
export PATH="$HOME/.local/protoc/bin:$PATH"
protoc --version
```

## Test

Health:

```bash
curl https://<your-domain>/health
```

Go proxy list example:

```bash
curl https://<your-domain>/proxy/github.com/gin-gonic/gin/@v/list
```

Binary download examples:

```bash
curl -I https://<your-domain>/download/go/latest/linux/amd64
curl -I https://<your-domain>/download/buf/latest/linux/amd64
curl -I https://<your-domain>/download/protoc/latest/linux/amd64
```

Go module tidy example:

```bash
git clone https://github.com/gin-gonic/examples.git
cd examples
export GOPROXY="https://<your-domain>/proxy,direct"
go mod tidy
```

MCP Inspector:

```bash
npx @modelcontextprotocol/inspector@latest
```

Use MCP server URL:

```text
https://<your-domain>/mcp
```

## MCP tools

- `go_proxy_config` — returns Bash or PowerShell commands for `GOPROXY` and `go mod tidy`.
- `go_proxy_fetch` — fetches small Go module proxy artifacts such as `@latest`, `.info`, `.mod`, or version list.
- `go_mod_preflight` — parses a provided `go.mod` and checks declared `require` entries against the upstream Go proxy.
- `tool_download_config` — generates a Cloudflare download URL and install command for `go`, `buf`, or `protoc`.
- `tool_download_preflight` — HEAD-checks a resolved upstream binary artifact and returns status, content length, and metadata.
- `tool_download_bundle_manifest` — returns a standard Linux/macOS/Windows toolchain manifest for Go + buf + protoc.

Example MCP prompt after connecting this server to ChatGPT:

```text
Use Aisphere Go MCP to generate Linux amd64 install commands for Go, buf, and protoc.
```

## Important limitations

- This cannot make a closed ChatGPT sandbox magically use a system-wide network proxy. The sandbox must be able to call your Cloudflare URL, or the MCP client must explicitly call the MCP tools.
- It does not implement HTTP `CONNECT`, SOCKS5, SSH tunneling, Git protocol, or arbitrary TCP forwarding.
- It cannot run `go mod tidy` inside Cloudflare because Workers/Pages Functions do not provide a normal Linux process environment with the Go toolchain.
- Large module `.zip` bodies and binary tool archives are streamed through `/proxy` or `/download`; they are intentionally not returned inside MCP text tool responses.
- Private modules need a different design, usually a trusted origin service with credentials, or Cloudflare Tunnel to a small VM that can run `go env GOPRIVATE` and `git` safely.

## Recommended next step for aisphere offline builds

Use this project as layer 1:

```text
GOPROXY -> Cloudflare /proxy -> proxy.golang.org
curl    -> Cloudflare /download -> go.dev / GitHub Releases
```

For stronger offline development, add layer 2 later:

```text
MCP tool -> GitHub Actions job -> download Go/buf/protoc + go mod download/vendor -> artifact zip
```

That second layer is the right place to produce deterministic offline bundles for this assistant sandbox or Windows/Linux air-gapped environments.
