# git-edge

[![npm version](https://img.shields.io/npm/v/git-edge.svg)](https://www.npmjs.com/package/git-edge)
[![CI](https://github.com/nandan-varma/git-edge/actions/workflows/ci.yml/badge.svg)](https://github.com/nandan-varma/git-edge/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/git-edge.svg)](LICENSE)

High-level edge-compatible git operations on top of [isomorphic-git](https://isomorphic-git.org): a parsed-object LRU cache, an object-level three-way merge that never needs a worktree, and repo-cache/init utilities. No `node:*` imports anywhere in `src/` — runs on Cloudflare Workers, Vercel Edge, Deno Deploy, and Node.

Extracted from the same production git-hosting service as [`git-fs-s3`](https://www.npmjs.com/package/git-fs-s3) — the two compose (see below) but neither imports the other; both just agree on isomorphic-git's `{ fs, gitdir, cache? }` shape.

## Why

isomorphic-git's own `git.merge` needs a worktree — a real (or hydrated-to-`/tmp`) checkout to run its merge driver against. That's a problem for a bare repo living entirely in object storage with no durable disk: merging means materializing the whole tree locally first. `threeWayMerge` here works directly on the object graph (trees, blobs, commits) — no checkout, no worktree, safe to run inside a Lambda/Worker/Edge function that only ever sees `{ fs, gitdir }`.

Separately, isomorphic-git re-parses a packfile index from scratch on every `readTree`/`log`/`readObject` call unless callers share a `cache` object across calls — and even with that shared cache, higher-level *parsed* results (a rendered commit list, a resolved merge base) get recomputed every time. `createParsedObjectCache` is a generic LRU for exactly those parsed values, keyed however the caller likes.

## Install

```bash
npm install git-edge isomorphic-git
```

`git-fs-s3` is an optional peer — install it if you need an S3/R2-backed `fs` to pass in; git-edge itself works with any isomorphic-git-compatible `fs` (including plain `node:fs`).

## Quick start

```typescript
import git from "isomorphic-git";
import fs from "node:fs";
import { threeWayMerge, GitMergeConflictError } from "git-edge";

const repo = { fs, gitdir: "/repo.git", cache: {} };

try {
  const { commitOid } = await threeWayMerge(repo, "feature", "main", {
    authorName: "Ada",
    authorEmail: "ada@example.com",
  });
  console.log("merged:", commitOid);
} catch (err) {
  if (err instanceof GitMergeConflictError) {
    console.log("conflicts in:", err.conflictingPaths);
  } else {
    throw err;
  }
}
```

### With git-fs-s3

```typescript
import { createGitFs, MemoryObjectStore } from "git-fs-s3";
import { threeWayMerge, initBareRepo } from "git-edge";

const fs = createGitFs(new MemoryObjectStore());
const repo = { fs, gitdir: "/repo.git", cache: {} };

await initBareRepo(repo);
// ... commits land on "feature" and "main" via git-fs-s3's fs ...
await threeWayMerge(repo, "feature", "main");
```

## API

### `threeWayMerge(repo, sourceRef, targetRef, opts?)`

Merges `sourceRef` into `targetRef` at the object level — no worktree.

- Source is an ancestor of target, or vice versa → fast-forward: just moves `targetRef`, no merge commit.
- Otherwise, flattens both trees (deep, recursive) against their merge base, takes non-conflicting changes automatically, and content-merges paths both sides touched with a line-level three-way merge.
- Throws `GitMergeConflictError` (with `conflictingPaths: string[]`) if any file has unresolved conflicts. The conflict markers (`<<<<<<< ours` / `=======` / `>>>>>>> theirs`) are still written to a blob and included in the (unreached) result tree — a caller that wants "write the conflicted state so a human can resolve it" can catch the error, note the paths, and re-run its own resolution flow rather than losing that information.
- `opts.message`, `opts.authorName`/`opts.authorEmail` (default `"Git Edge" <git-edge@local>`).

Returns `{ commitOid }` — the new merge commit, or the fast-forwarded `targetRef`'s new oid.

### `analyzeMerge(repo, sourceRef, targetRef)`

Cheap pre-merge check: resolves both refs and checks ancestry. Returns `{ canMerge, fastForward, diverged }` — `canMerge: false` only means a ref failed to resolve, not that a real merge would conflict (that's only knowable by attempting one; this doesn't walk trees at all). Safe to call before deciding whether to show a "conflicts likely" hint in a UI.

### `createParsedObjectCache(options?)`

A generic in-memory LRU for any JS value, keyed by caller-chosen strings (convention: `` `${oid}:${format}` ``).

```typescript
const cache = createParsedObjectCache({ maxSize: 128 * 1024 * 1024, ttl: 3600_000 });
cache.set(`${oid}:commit`, parsedCommit);
const hit = cache.get<ParsedCommit>(`${oid}:commit`);
cache.invalidatePrefix(gitdir); // drop everything under a repo after a rewrite
```

- `options.maxSize` — byte budget, estimated via `JSON.stringify(value).length` (default 256 MiB).
- `options.ttl` — entry TTL in ms (default 1 h).
- `.invalidatePrefix(prefix)` — drop every key starting with `prefix`; O(cache size), fine for occasional invalidation, not a hot-path operation.

### `getRepoCache(ownerKey, repoName)` / `invalidateRepoCache(ownerKey, repoName)`

Per-repo isomorphic-git packfile `cache` object management, keyed `` `${ownerKey}/${repoName}` ``. isomorphic-git treats this `cache` as opaque and safe to share indefinitely (git objects are content-addressed/immutable), so a long-lived per-repo instance turns "reparse this pack's index" from once-per-call into once-per-process. Call `invalidateRepoCache` after anything rewrites a repo's storage out from under a live process (a rename, a bulk resync) so stale parsed state can't leak into the next read.

### `initBareRepo(repo, defaultBranch?)`

Thin wrapper over `git.init({ ...repo, bare: true })` — accepts any fs (git-fs-s3-backed, `node:fs`, in-memory), defaults `defaultBranch` to `"main"`.

### `estimateRepoSize(repo, stat, list)`

Sums `.pack`/loose-object file sizes under `objects/`. Caller supplies `stat`/`list` since "size of a file" isn't part of isomorphic-git's own `fs` contract — for `node:fs` that's `fs.stat`/`fs.readdir`; for an object-storage-backed fs it's typically a HEAD request per key. Can be expensive against remote storage — prefer tracking size incrementally at write time where possible.

### Errors

`GitEdgeError` — base class. `GitMergeConflictError extends GitEdgeError` — `conflictingPaths: string[]`, thrown only by `threeWayMerge`.

## Semantics & limitations

- `threeWayMerge`'s content merge is a from-scratch line-level three-way merge (not `diff3`/libgit2), used only for paths both sides changed from the merge base — most changes (added/deleted/single-side-modified) resolve without touching it at all.
- No binary-file merge support — conflict markers are written as text into whatever bytes the paths held; binary content will produce a nonsensical merged blob, not a clean conflict signal. Detect binary paths upstream if that matters for your use case.
- `estimateRepoSize` and the parsed-object cache are general-purpose helpers, not required by `threeWayMerge`/`analyzeMerge` — use whichever pieces you need independently.

## License

[MIT](LICENSE)
