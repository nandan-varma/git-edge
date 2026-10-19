# Changelog

This changelog is derived from this repository's release history; it is ordered newest first.

## [0.6.0] - 2026-10-19

### Changed

- Requires isomorphic-git 1.44.3 or later (peer range and dev dependency).
  Earlier versions swallowed read and readdir errors other than
  file-not-found (fixed upstream in 1.44.3, isomorphic-git#2461), so a
  transient object-store failure could surface as a missing object instead
  of an error.
- Dev dependency on git-fs-s3 moves to ^0.12.1.

## [0.5.0] - 2026-10-18

### Changed

- Licence: AGPL-3.0-or-later (was MIT). Versions up to and including `0.4.2`
  were published under MIT and remain available under it; from this release
  onward, a network service built on this package must offer its users the
  corresponding source (AGPL section 13).

## [0.4.2](https://github.com/nandan-varma/git-edge/compare/v0.4.1...v0.4.2) - 2026-10-18

### Changed

- `threeWayMerge` bounds the object reads and writes it has in flight to 16 per
  call (`MAX_CONCURRENT_READS`), using one semaphore created per merge. A
  directory's entries are still merged concurrently, but the permit wraps a
  single `readTree`/`readBlob`/`writeTree`/`writeBlob` call and is released
  before the recursive subtree merge, so a wide tree cannot deadlock itself.

### Added

- Regression tests for submodule pointer merges and conflicts.

## [0.4.1](https://github.com/nandan-varma/git-edge/compare/v0.4.0...v0.4.1) - 2026-10-18

### Changed

- Publishing goes through npm trusted publishing in the release workflow.

## [0.4.0](https://github.com/nandan-varma/git-edge/compare/v0.3.0...v0.4.0) - 2026-10-18

### Changed

- `threeWayMerge` is now a recursive tree merge against the merge base.
  Subtrees only one side touched are taken by oid, never read.
- New objects are stored as one pack through `git-fs-s3`'s
  `withPackedWrites`, written before the ref moves. `git-fs-s3` ≥ 0.8.0 is now
  a required peer.
- Conflicts throw `GitMergeConflictError` with sorted `conflictingPaths` before
  anything is written.
- Upgraded the docs dependencies (astro, starlight, sharp) to patch
  advisories.

### Fixed

- A target that already contains the source is a no-op. It previously moved the
  target ref back to source, orphaning the target's newer commits.
- The merge commit no longer advances the branch `HEAD` names; only `targetRef`
  moves.
- Deletions made on one side now win instead of the file reappearing from the
  other side. Modify/delete is a conflict.
- File modes are preserved. Every entry was previously rewritten as mode
  `100644`, losing executable bits and corrupting symlinks and submodules. A
  mode change one side made wins; both changing it differently is a conflict.
- A file on one side and a directory on the other is a conflict instead of
  producing two same-named tree entries. Symlink and submodule changes both
  sides made are conflicts too.
- Binary files (a NUL byte in any version) are no longer line-merged; both sides
  changing one is a conflict.
- Unrelated histories throw `GitEdgeError`.

## [0.3.0](https://github.com/nandan-varma/git-edge/compare/v0.2.3...v0.3.0) - 2026-10-11

### Changed

- The package is now ESM-only, requires Node 22+, and targets TypeScript 7.
- `git-fs-s3` peer bumped to ≥ 0.5.0.
- Restored the CI workflow files (Node 22/24) that the 0.3.0 commit had emptied.

## [0.2.3](https://github.com/nandan-varma/git-edge/compare/v0.2.2...v0.2.3) - 2026-10-11

### Changed

- The per-repo isomorphic-git packfile caches are bounded to 32 repos, evicting
  the least recently used.
- Cache entry sizes are estimated by walking the value instead of running
  `JSON.stringify` on every `set()`.
- Dependency maintenance.

## [0.2.2](https://github.com/nandan-varma/git-edge/compare/v0.2.1...v0.2.2) - 2026-08-31

### Changed

- README updates for 0.2.0 and 0.2.1. No code changes; republished to refresh
  the npm registry page.

## [0.2.1](https://github.com/nandan-varma/git-edge/compare/v0.2.0...v0.2.1) - 2026-08-31

### Fixed

- Replaced the hand-rolled line merge with `node-diff3`'s diff3. The previous
  index-by-index walk misaligned lines after any insertion or deletion on either
  side, which could report false conflicts or silently merge misaligned lines
  into corrupted content.

## [0.2.0](https://github.com/nandan-varma/git-edge/compare/v0.1.3...v0.2.0) - 2026-08-31

### Changed

- Breaking: removed the unused `initBareRepo`, `estimateRepoSize`,
  `analyzeMerge`, and `MergeAnalysis` exports.
- Consolidated the `Repo` type to import from `git-fs-s3/ops`.
- Removed the unused `_flattenTree` helper from `merge.ts`.
- Documented the added-independently-on-both-sides merge case and updated the
  docs dependencies.

## [0.1.3] - 2026-08-28

### Added

- Package scaffold for publishing: README, LICENSE, CI, and Biome.
- Astro Starlight documentation site.

### Changed

- Renamed the package to the unscoped `git-edge` and depended on the unscoped
  `git-fs-s3`.
- Pinned a patched esbuild dev-toolchain version and committed the lockfile.

### Fixed

- `analyzeMerge` now propagates non-`NotFoundError` failures instead of
  swallowing them.
- Fixed a crash when both sides independently added a path with no common
  ancestor entry, and removed all non-null assertions from `merge.ts`.
- Patched js-yaml, nanoid, postcss, and sharp advisories.
