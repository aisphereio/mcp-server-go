# mcp-server-go

Cloudflare Workers / Cloudflare Pages Functions based MCP server for Go development in restricted network environments.

It exposes two things:

1. `GET /proxy/...` — a Go module proxy bridge. Set `GOPROXY` to this endpoint and run `go mod tidy` locally, in Codespaces, or in another sandbox that can reach Cloudflare.
2. `POST /mcp` — a remote MCP endpoint with tools that can generate Go proxy config and preflight module reachability.

This is not a generic TCP proxy and it does not run the Go compiler inside Cloudflare. Cloudflare Workers/Pages Functions are best used here as an HTTP bridge to an upstream Go module proxy, usually `https://proxy.golang.org`.

## Architecture

```text
ChatGPT / MCP client
        |
        | Streamable HTTP MCP
        v
Cloudflare /mcp -------------- tools: go_proxy_config, go_proxy_fetch, go_mod_preflight
        |
        | normal HTTP Go proxy protocol
        v
Cloudflare /proxy/* ---------- streams to UPSTREAM_GOPROXY
        |
        v
https://proxy.golang.org
```

For the actual `go mod tidy` path, the important endpoint is `/proxy`, because the Go tool already knows how to speak the Go module proxy protocol.

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
| `PROXY_TOKEN` | No | If set, Go proxy URL becomes `/proxy/<token>`. |
| `MCP_BEARER_TOKEN` | No | If set, `/mcp` requires `Authorization: Bearer <token>`. |
| `ALLOW_MODULE_PREFIXES` | No | Comma-separated allowlist, for example `github.com/aisphereio/`. |
| `BLOCK_MODULE_PREFIXES` | No | Comma-separated blocklist. |

## Secure proxy URL

If you set `PROXY_TOKEN=abc123`, use this as the Go proxy base:

```bash
export GOPROXY="https://<your-domain>/proxy/abc123,direct"
go mod tidy
```

For public modules this is usually enough. Do not use this to expose private module credentials.

## Test

Health:

```bash
curl https://<your-domain>/health
```

Go proxy list example:

```bash
curl https://<your-domain>/proxy/github.com/gin-gonic/gin/@v/list
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

## Important limitations

- This cannot make a closed ChatGPT sandbox magically use a system-wide network proxy. The sandbox must be able to call your Cloudflare URL, or the MCP client must explicitly call the MCP tools.
- It does not implement HTTP `CONNECT`, SOCKS5, SSH tunneling, Git protocol, or arbitrary TCP forwarding.
- It cannot run `go mod tidy` inside Cloudflare because Workers/Pages Functions do not provide a normal Linux process environment with the Go toolchain.
- Large `.zip` module bodies are streamed through `/proxy`; they are intentionally not returned inside MCP text tool responses.
- Private modules need a different design, usually a trusted origin service with credentials, or Cloudflare Tunnel to a small VM that can run `go env GOPRIVATE` and `git` safely.

## Recommended next step for aisphere offline builds

Use this project as layer 1:

```text
GOPROXY -> Cloudflare /proxy -> proxy.golang.org
```

For stronger offline development, add layer 2 later:

```text
MCP tool -> GitHub Actions job -> go mod download/vendor -> artifact zip
```

That second layer is the right place to produce deterministic offline bundles for this assistant sandbox or Windows/Linux air-gapped environments.
