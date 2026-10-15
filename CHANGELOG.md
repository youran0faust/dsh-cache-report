# Changelog

## [0.1.1] - 2026-10-15

### Added

- `debug` subcommand — a format self-check. Prints a contract table (frame
  decoding, `usage` field names, tool table, `reason`), the actual `usage`
  field-name combinations DSH is emitting, and an event-type histogram, then
  states whether the tool's assumptions still hold. Run this first whenever
  numbers look wrong, and after every DSH upgrade.
- `MAINTAINING.md` — handoff notes: architecture, the exact data contracts this
  tool depends on, known fragilities with symptoms and where to look, and the
  release procedure.
- CI and Node-version badges in both READMEs.

### Notes

- The `debug` self-check deliberately distinguishes requests that carry
  `cacheReadTokens` from those that do not (subagent and side requests often
  omit it). The first version of this check misreported that difference as
  format breakage; the composition table now makes it explicit.

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
