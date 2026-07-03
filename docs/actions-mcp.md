# Actions MCP artifact mode

This document describes the extra MCP endpoint that solves the important boundary problem:

> MCP tools are not transparent network proxies for a ChatGPT sandbox shell. They can call remote services and return tool results, but they cannot automatically make `git`, `curl`, or `go mod tidy` inside a sandbox use that network.

The new design adds an artifact/job mode:

```text
ChatGPT / MCP client
  -> Cloudflare /mcp-actions
  -> GitHub Actions workflow_dispatch
  -> GitHub runner clones repo / runs Go commands / packages outputs
  -> GitHub Actions artifact
```

This keeps Cloudflare as a lightweight control plane and uses GitHub Actions as the execution/data plane.

## New endpoint

```text
https://<your-domain>/mcp-actions
```

The original endpoint still exists:

```text
https://<your-domain>/mcp
```

`/mcp` keeps the existing Go proxy, download, and GitHub preflight helpers. `/mcp-actions` adds job/artifact tools.

## New MCP tools

| Tool | What it does |
| --- | --- |
| `github_repo_archive_fetch` | Triggers GitHub Actions to clone a GitHub repository/ref and upload source archives as an artifact. |
| `go_mod_download_bundle` | Triggers GitHub Actions to clone a repo, run `go mod download`, package source + `GOMODCACHE`, and upload an artifact. |
| `go_mod_tidy_remote` | Triggers GitHub Actions to clone a repo, run `go mod tidy`, capture logs and `go.mod/go.sum` diffs, and upload an artifact. |
| `offline_bundle_status` | Finds the GitHub Actions run and artifacts for a returned `requestId`. |
| `offline_bundle_plan` | Explains the workflow and parameters without triggering a run. |

## Required Cloudflare variables

Add these to Worker / Pages `Settings -> Variables & Secrets`:

```text
GITHUB_ACTION_TOKEN=<GitHub token with Actions workflow permission>
GITHUB_ACTION_REPO=aisphereio/mcp-server-go
GITHUB_ACTION_REF=main
GITHUB_ALLOW_OWNERS=aisphereio
```

Recommended security variables:

```text
ACTIONS_MCP_BEARER_TOKEN=<long-random-token>
GITHUB_PROXY_TOKEN=<long-random-token>
PROXY_TOKEN=<long-random-token>
DOWNLOAD_TOKEN=<long-random-token>
```

`ACTIONS_MCP_BEARER_TOKEN` protects `/mcp-actions` and `/actions/*`. If it is omitted, `/mcp-actions` is public. Do not leave it public if `GITHUB_ACTION_TOKEN` is configured.

## GitHub token permissions

Use a fine-grained token for the repository that hosts this MCP server, usually:

```text
aisphereio/mcp-server-go
```

Minimum practical permissions:

```text
Actions: Read and write
Contents: Read
Metadata: Read
```

The Worker uses the token to call:

```text
POST /repos/{owner}/{repo}/actions/workflows/offline-bundle.yml/dispatches
GET  /repos/{owner}/{repo}/actions/workflows/offline-bundle.yml/runs
GET  /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts
```

## GitHub Actions workflow

The workflow lives at:

```text
.github/workflows/offline-bundle.yml
```

It supports three modes:

```text
archive  -> clone repository and upload repo-source.zip / repo-source.tar.gz
gomod    -> clone repository, run go mod download, upload source + gomodcache.tar.gz
tidy     -> clone repository, run go mod download + go mod tidy, upload logs + go.mod/go.sum before/after + diff
```

Artifact name shape:

```text
aisphere-offline-{mode}-{request_id}
```

## Example MCP usage

After connecting `https://<your-domain>/mcp-actions` as a ChatGPT connector, ask:

```text
Use Aisphere Go Actions MCP to run go_mod_download_bundle for https://github.com/aisphereio/kernel.git ref main using Go 1.26.4.
```

The tool returns a `requestId`, for example:

```text
gomod-lx7g2abc-k12m3n4
```

Then ask:

```text
Use offline_bundle_status for requestId gomod-lx7g2abc-k12m3n4.
```

When the GitHub Action completes, it returns the Actions run URL and artifact metadata.

## HTTP usage without ChatGPT connector

Trigger a job:

```bash
curl -X POST https://<your-domain>/actions/offline-bundle \
  -H 'Authorization: Bearer <ACTIONS_MCP_BEARER_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{
    "repository": "aisphereio/kernel",
    "ref": "main",
    "goVersion": "1.26.4",
    "mode": "gomod"
  }'
```

Check status:

```bash
curl 'https://<your-domain>/actions/status?request_id=<requestId>' \
  -H 'Authorization: Bearer <ACTIONS_MCP_BEARER_TOKEN>'
```

## Boundary statement

This still does not mount files into `/mnt/data` automatically. It produces a GitHub Actions artifact that can be downloaded from GitHub UI/API. That is the correct production-grade bridge when the ChatGPT sandbox cannot resolve Cloudflare/GitHub/Go Proxy directly.

For this assistant environment specifically, a separate trusted connector or artifact download tool is still required to turn the Actions artifact into a local `/mnt/data/*.zip` file.
