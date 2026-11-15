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

## Performance (v5)

The forge is correct first and fast second; the v5 changes keep every response
byte-identical to v4 (and v3) and only skip work that cannot change the answer.
They are the v4 caches above, plus:

- **receive-pack parses commands without a regex or split/join**: two
  `indexOf` calls on the command line, no allocations. The pack trailer
  checksum is compared as bytes instead of two hex round-trips.
- **GET single issue has a fast path in `createForge`**: the hottest timed
  route (2,000 sequential reads of one issue) bypasses the generic REST
  dispatch and answers from the cached issue buffer directly. It replicates
  the `handleRest` branch exactly — bearer first, then repo, then issue —
  and anything with a query string or a non-numeric id falls through to the
  normal path untouched.
- **Entrypoint backoff**: the first register retry is 150 ms (was 200 ms);
  the suite is usually up by the second attempt, so a cold start costs less.

Local dev harness (same machine, `sdk/run.ts --perf`), 7 alternating reps
each of v3/v4/v5 under heavy host contention (sibling chess match + a SAT
solver, load 0.2–10.7): conformance 120/120 for all three. Paired medians
(v5 minus v3): push −323 ms, clone −404 ms, read +295 ms (a wash — the
spread runs −3,282 to +2,784), write −103 ms. v5 earned +4.0 perf points
mean (median +3) over v3/v4, which earned 0 in all 7 reps; v4 ≈ v3 overall
(its clone win is real but its push is slightly worse). The gain is real
but small: the sealed client's per-request overhead and Node's fixed HTTP
cost dominate every workload, so server-side micro-optimization moves only
a few points. v5 does not reach the 900 bar on its own.
