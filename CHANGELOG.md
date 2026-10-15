# Changelog

## [0.1.0] - 2026-10-15

### Added

- Initial release.
- `today` — current-day hit rate plus attribution of large recomputes
  (>= 50k miss tokens) to `toolset-change` / `compaction` / `session-start` / `resume`.
- `days N` — daily trend table.
- `tools N` — tool-block cost estimate, per-plugin breakdown, and tools that
  were never called across the observed window.
- `before-after H` — tool-table size timeline, recompute cost attributed to
  toolset changes, and the real spend from the local usage ledger.
- `/cache-report` slash command registered by the DSH plugin half.
  Registers no tools, so it does not change the tool table.
