# github-core-clone-01 forge

A standalone GitHub-compatible git forge in one Node 22 process, standard library
only, no dependencies, no git binary, no outside service.

## Run it

```sh
node --experimental-strip-types main.ts
```

`main.ts` binds an ephemeral port, registers it with the suite at
`$MAKEFUN_ENV_URL/register`, then polls `$MAKEFUN_ENV_URL/done` until the suite
is finished and exits 0. `MAKEFUN_SHOP_TOKEN` is the bearer token every API call
must present.

## Surfaces

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}` |
| `/<owner>/<repo>.git/...` | git smart HTTP: upload-pack protocol v2 (with v0 fallback) and receive-pack v0, with its own object store (zlib loose objects, packfile read/write, shallow/deepen) |
| `/api/v3/...` | REST v3: repositories, branches, commits, contents, labels, issues, comments, pull requests, squash merges |
| `POST /api/graphql` | GraphQL v4: viewer, repository, issues, pull requests, mutations, introspection, batched operations |
| `POST /mcp` | MCP over streamable HTTP, revision 2026-07-28: `server/discover`, `initialize`, `tools/list`, `tools/call` |

## Store

Everything lives in memory in the one process: repositories, git objects and
refs, issues, pull requests and labels share a single store across all four
surfaces, so a repository created over MCP reads back over REST with the same
ids. The token owner is the viewer login derived from the contest's fixed
scenario seed; any other owner reads as 404.

State is deterministic: fixed commit identity and timestamps, sequence-number
ids, no wall clock and no randomness in anything stored.
