# dsh-cache-report

[![CI](https://github.com/youran0faust/dsh-cache-report/actions/workflows/ci.yml/badge.svg)](https://github.com/youran0faust/dsh-cache-report/actions/workflows/ci.yml) ![node](https://img.shields.io/badge/node-%3E%3D22.15-brightgreen)

> **Your hit rate fell from 96% to 80%. What ate it?**

Prompt-cache hit rate and tool-block cost report for DSH (DeepSeek Harness). One command tells you where today's tokens went, which action cost the most, and which plugins are just taking up space.

> [中文](README.md) | English · MIT · zero runtime dependencies

## The question it answers

Model input is billed at two very different rates: **cache hit** and **cache miss** (roughly **1 : 10** on DeepSeek). Caching matches an exact **prefix**, and a request is laid out like this:

```
[tool definitions]  <- change anything here and everything below is void
[system prompt]
[history ...]       <- this is what the cache actually reuses
[this turn]         <- the only part that should be billed as a miss
```

So: **install a plugin mid-conversation, toggle a component, or flip a permission preset, and the tool definitions change — after which the whole context (system prompt + all history) is reprocessed at full price.**

Most people see the hit rate drop and never learn what caused it. This tool answers that.

## Install

Requires DSH (`@deepseek-ai/dsh`) and Node.js >= 20.

### Option A: as a DSH plugin (recommended)

```bash
dsh plugin --profile web add github:youran0faust/dsh-cache-report#main
```

Restart DSH (or rely on the profile's `patchReload: live`), then type in any session:

```
/cache-report
```

It registers **slash commands only — no tools at all**. It never changes the tool table and therefore **never invalidates your own prompt cache**. Zero standing cost.

### Option B: standalone script

```bash
git clone https://github.com/youran0faust/dsh-cache-report.git
node dsh-cache-report/lib/report.mjs today
```

Zero runtime dependencies — Node builtins only (`node:fs`, `node:path`, `node:zlib`, `node:os`).

## Commands

| Input | What it does |
|---|---|
| `/cache-report` | no argument = `today`: hit rate plus attribution of large recomputes |
| `/cache-report days 7` | daily trend table |
| `/cache-report tools 30` | tool-block cost, per-plugin breakdown, never-called dead weight |
| `/cache-report before-after 24` | tool-table change timeline, recompute cost, real ledger spend |
| `/cache-report debug 7` | format self-check: does the DSH session format still match? |
| `/cache-report help` | usage |

Standalone equivalents: `node lib/report.mjs days 7`, and so on.

## Example output

> Numbers below are **illustrative**, shown to demonstrate the output shape.

```
$ /cache-report days 7

# last 7 days (scanned 96 session files)

date          reqs    hit rate   miss tokens     hit tokens  big recomputes  top cause
2026-10-09     412      95.8%      1,204,331     27,461,882              12  compaction 41%
2026-10-10     688      96.1%      1,988,204     48,932,110              19  compaction 52%
2026-10-11     903      95.4%      2,741,558     56,880,231              27  compaction 47%
2026-10-12     744      94.9%      2,105,772     39,204,118              22  compaction 55%
2026-10-13     611      92.3%      3,388,901     40,612,447              38  compaction 58%
2026-10-14     402      79.5%      6,120,338     23,742,905              61  compaction 74%
2026-10-15     288      73.6%      4,884,120     13,618,442              44  toolset-change 48%
```

The knee is on 10-14, and the **attribution changes hands**: from `compaction` to `toolset-change` — the day several plugins were installed.

```
$ /cache-report tools

source              tools      tok   share   never called
  agent-teams          14    4,508   24.9%    ~4,407 tok
  host-core            21    4,308   23.8%      ~224 tok
  dsh-mnemon           17    3,579   19.8%    ~1,315 tok
  dsh-ops               5    2,056   11.4%      ~378 tok
  dsh-undo-savepoint   15    1,936   10.7%    ~1,557 tok
  shell/job             4    1,151    6.4%          -
  modsearch             4      520    2.9%      ~190 tok

## never called (37 tools / ~8,071 tok)
  ~  790 tok  agent_teams_create_task          agent-teams
  ~  752 tok  agent_teams_update_task          agent-teams
  ...
```

## How to read it: the hit rate is a **ratio trap**

**Hit rate = hits / (hits + misses).** But **never look at the ratio alone** — it is diluted or inflated by context length:

| | Hit rate | Tokens per request | Actual cost |
|---|---|---|---|
| Long session | 96% | 190k | higher |
| Short session | 80% | 148k | **lower** |

The ratio can drop while the bill drops with it. **What matters is the absolute miss-token count** — that is the part billed at full price.

Any request with **>= 50,000 miss tokens** (tunable via `DSH_REPORT_BIG`) is called a **large recompute**, attributed to a cause:

| Cause | Meaning | In your control? |
|---|---|---|
| `toolset-change` | plugin installed/removed, component toggled, permission preset switched | ✅ **Yes** — batch your changes, then start a new session |
| `compaction` | history compaction (the unavoidable cost of long sessions) | ⚠️ Partly — don't let sessions grow forever |
| `session-start` | cold start of a new session | ⛔ Normal |
| `resume` | reopening an old session | ⛔ Normal |

### Three rules that actually save money

1. **Batch plugin installs; start a new session afterwards.** Install one mid-conversation and the current session's whole history is reprocessed at full price.
2. **Never switch models or permission presets inside a long session.** Same reason: you are rewriting the prefix.
3. **Watch absolute miss tokens, not the percentage.**

## Data source and privacy

It reads your local DSH session logs: `session.v*.jsonl.zstd` under `$DSH_HOME/sessions/` (multi-frame zstd; frames are split by magic number and decoded one by one).

Only two things are used:

- `assistant/message` → `usage.inputTokens` (miss) / `usage.cacheReadTokens` (hit)
- `request/header` → the tool definitions in force, plus `reason` (`initial` / `series` / `resume` / `change`)

**No conversation content, file content, or secrets are ever printed**; `tools` prints tool *names* only. Everything runs locally: **no network access, no upload**.

## Limitations (honestly)

- **Token counts are estimates**: tool blocks are estimated as `ASCII chars / 4 + non-ASCII chars / 1.5`, roughly ±10%.
- **Attribution is heuristic**: it blames the most recent cause event before a large recompute. When compaction and a toolset change land close together, it can misattribute.
- **Only what is observable**: it reads session logs DSH actually wrote to disk; sessions that were trimmed or never flushed are not counted.
- **zstd requires Node >= 22.15** (the `node:zlib` zstd API). Older Node fails.

## Uninstall

```bash
dsh plugin --profile web remove dsh-cache-report
```

Or just delete the directory for a standalone copy. It writes no configuration, spawns no daemon, and keeps no state.

## Development

```bash
node lib/report.mjs help        # self-check
node lib/report.mjs days 2      # quick smoke test
```

## License

MIT
