# git-edge

[![npm version](https://img.shields.io/npm/v/git-edge.svg)](https://www.npmjs.com/package/git-edge)
[![CI](https://github.com/nandan-varma/git-edge/actions/workflows/ci.yml/badge.svg)](https://github.com/nandan-varma/git-edge/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/git-edge.svg)](LICENSE)

High-level edge-compatible git operations on top of [isomorphic-git](https://isomorphic-git.org): a parsed-object LRU cache, an object-level three-way merge that never needs a worktree, and per-repo packfile-cache management. No `node:*` imports anywhere in `src/` — runs on Cloudflare Workers, Vercel Edge, Deno Deploy, and Node.

Extracted from the same production git-hosting service as [`git-fs-s3`](https://www.npmjs.com/package/git-fs-s3) — the two compose (see below): both work on isomorphic-git's `{ fs, gitdir, cache? }` shape, and `threeWayMerge` stores its objects through git-fs-s3's `withPackedWrites`.

## Why

isomorphic-git's own `git.merge` needs a worktree — a real (or hydrated-to-`/tmp`) checkout to run its merge driver against. That's a problem for a bare repo living entirely in object storage with no durable disk: merging means materializing the whole tree locally first. `threeWayMerge` here works directly on the object graph (trees, blobs, commits) — no checkout, no worktree, safe to run inside a Lambda/Worker/Edge function that only ever sees `{ fs, gitdir }`.

Separately, isomorphic-git re-parses a packfile index from scratch on every `readTree`/`log`/`readObject` call unless callers share a `cache` object across calls — and even with that shared cache, higher-level *parsed* results (a rendered commit list, a resolved merge base) get recomputed every time. `createParsedObjectCache` is a generic LRU for exactly those parsed values, keyed however the caller likes.

## Install

```bash
npm install git-edge git-fs-s3 isomorphic-git   # ESM only, Node.js 22+
```

`git-fs-s3` (≥ 0.8) is a required peer — `threeWayMerge` uses its `withPackedWrites`. git-edge works with any isomorphic-git-compatible `fs` (including plain `node:fs`), not just git-fs-s3's.

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
import git from "isomorphic-git";
import { createGitFs, MemoryObjectStore } from "git-fs-s3";
import { threeWayMerge } from "git-edge";

const fs = createGitFs(new MemoryObjectStore());
const repo = { fs, gitdir: "/repo.git", cache: {} };

await git.init({ ...repo, dir: repo.gitdir, bare: true });
// ... commits land on "feature" and "main" via git-fs-s3's fs ...
await threeWayMerge(repo, "feature", "main");
```

## API

### `threeWayMerge(repo, sourceRef, targetRef, opts?)`

Merges `sourceRef` into `targetRef` at the object level — no worktree.

- Target already contains source (same commit, or source is an ancestor) → nothing to do: returns target's oid, no ref moves.
- Source is a descendant of target → fast-forward: just moves `targetRef`, no merge commit.
- Otherwise, merges the trees recursively against their merge base: a change only one side made wins (deletions and mode changes included), subtrees only one side touched are taken without being read, and text files both sides changed are content-merged with diff3. Binary files, symlinks, submodules, modify/delete and file/directory clashes that both sides touched are conflicts. Unrelated histories throw `GitEdgeError`.
- Throws `GitMergeConflictError` (with sorted `conflictingPaths: string[]`) if anything conflicts — before writing anything.
- Only `targetRef` moves (never the branch `HEAD` names); new objects are stored as one pack via git-fs-s3's `withPackedWrites`, before the ref.
- `opts.message`, `opts.authorName`/`opts.authorEmail` (default `"Git Edge" <git-edge@local>`).

Returns `{ commitOid }` — the new merge commit, or the fast-forwarded `targetRef`'s new oid.

Want a cheap pre-merge check (resolve both refs, check ancestry, no tree walk
— "would this be a fast-forward, or has it diverged") before deciding whether
to show a "conflicts likely" hint in a UI? That's `git-fs-s3/ops`'s
`analyzeMerge`, not this package's — it composes with `threeWayMerge` (same
`{ fs, gitdir, cache? }` shape) without either package importing the other.

### `createParsedObjectCache(options?)`

A generic in-memory LRU for any JS value, keyed by caller-chosen strings (convention: `` `${oid}:${format}` ``).

```typescript
const cache = createParsedObjectCache({ maxSize: 128 * 1024 * 1024, ttl: 3600_000 });
cache.set(`${oid}:commit`, parsedCommit);
const hit = cache.get<ParsedCommit>(`${oid}:commit`);
cache.invalidatePrefix(gitdir); // drop everything under a repo after a rewrite
```

- `options.maxSize` — approximate byte budget; each entry is sized by walking its value, without serialization (default 256 MiB).
- `options.ttl` — entry TTL in ms (default 1 h).
- `.invalidatePrefix(prefix)` — drop every key starting with `prefix`; O(cache size), fine for occasional invalidation, not a hot-path operation.

### `getRepoCache(ownerKey, repoName)` / `invalidateRepoCache(ownerKey, repoName)`

Per-repo isomorphic-git packfile `cache` object management, keyed `` `${ownerKey}/${repoName}` ``. isomorphic-git treats this `cache` as opaque and safe to share indefinitely (git objects are content-addressed/immutable), so a long-lived per-repo instance turns "reparse this pack's index" from once-per-call into once-per-process. Call `invalidateRepoCache` after anything rewrites a repo's storage out from under a live process (a rename, a bulk resync) so stale parsed state can't leak into the next read.

### Errors

`GitEdgeError` — base class. `GitMergeConflictError extends GitEdgeError` — `conflictingPaths: string[]`, thrown only by `threeWayMerge`.

## Semantics & limitations

- `threeWayMerge`'s content merge (for paths both sides changed from the merge base — most changes are added/deleted/single-side-modified and resolve without touching it at all) uses [`node-diff3`](https://www.npmjs.com/package/node-diff3)'s LCS-based diff3 algorithm, the same approach GNU diffutils' `diff3` and git's own default merge driver use.
- Binary files (a NUL byte in any version) are never line-merged; both sides changing one is a conflict. No rename detection; criss-cross histories use the first merge base.
- Object reads and writes are bounded (`MAX_CONCURRENT_READS = 16` in-flight per merge, held for each individual `readTree`/`readBlob`/`writeBlob`/`writeTree` call rather than across the recursive subtree merge). A directory's entries are merged concurrently, so an unbounded fan-out over a repo with tens of thousands of entries in one directory would otherwise issue that many simultaneous store requests from a single merge, with each `readBlob` holding a whole blob in memory.
- The parsed-object cache and `getRepoCache`/`invalidateRepoCache` are general-purpose helpers, not required by `threeWayMerge` — use whichever pieces you need independently.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for what changed in each release.

## License

[MIT](LICENSE)
