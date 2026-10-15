# Maintaining dsh-cache-report

> **中文摘要**：这份文档写给接手维护的人。核心只有一句——**本工具依赖 DSH 的会话日志内部格式**（多帧 zstd + 特定事件字段），那是唯一会随 DSH 升级而失效的地方。升级 DSH 后先跑 `node lib/report.mjs debug`，它会逐项自检并告诉你哪一条契约破了。

## Architecture

Two entry points, one engine:

| File | Role |
|---|---|
| `lib/report.mjs` | The engine. Pure Node builtins, no dependencies. Also a standalone CLI. |
| `lib/index.js` | The DSH plugin half. Registers exactly one slash command (`/cache-report`) and spawns the engine via `process.execPath`. |

**Why spawn instead of import?** `lib/report.mjs` is written as a CLI with top-level side effects. Spawning keeps the host event loop free during the 12-second scan and isolates any engine crash from the DSH process. If you refactor the engine into a library, keep the CLI working — the standalone install path (`node lib/report.mjs`) is a documented feature.

**Why register no tools?** Tool definitions sit at the very front of every model request. Adding a tool invalidates the prompt cache for **every open session**, which is exactly the pathology this tool exists to measure. A diagnostic that causes the problem it diagnoses would be a bad joke. Keep `/cache-report` a command; do not add an `ops_`-style tool.

## Data contracts (the fragile part)

Source: `$DSH_HOME/sessions/**/session.v*.jsonl.zstd`.

### 1. File layout: multi-frame zstd

Each session file is a sequence of **independent zstd frames**, not one stream. `zlib.zstdDecompressSync()` decodes **only the first frame** and silently returns a truncated result — this is the single most likely way to break the engine.

The engine therefore scans the raw buffer for the zstd magic number `28 B5 2F FD`, slices at each occurrence, and decodes every slice.

### 2. Events

One JSON object per line. Every event has `type` (string) and `time` (ms epoch). Only these matter:

| Event | Field used | Meaning |
|---|---|---|
| `assistant/message` | `data.usage.inputTokens` | **uncached** prompt tokens |
| | `data.usage.cacheReadTokens` | **cached** prompt tokens |
| | `data.usage.outputTokens` | completion tokens |
| `request/header` | `data.header.tools[]` | full tool definitions in force |
| | `data.reason` | `initial` \| `series` \| `resume` \| `change` |
| `tool/call` | `data.name` | which tool was called |
| `compaction/end`, `model/selection`, `sandbox/mode`, `permission/preset` | — | attribution markers only |

Hit rate = `cacheReadTokens / (cacheReadTokens + inputTokens)`.

**Not every request carries `cacheReadTokens`.** Subagent and side requests often report only `inputTokens, outputTokens, totalTokens`. That is normal — do not treat it as format breakage. The engine simply counts those as full misses, which is the conservative reading.

### 3. Attribution model

The engine walks each session file in order, keeping a `lastCause` string updated by marker events. Any request whose `inputTokens` is at or above `DSH_REPORT_BIG` (default 50000) is a **large recompute** and is attributed to the then-current `lastCause`.

This is heuristic by construction, and documented as such in both READMEs. If marker events are renamed, attribution degrades toward `session-start` — it will not throw.

## Running the self-check

```bash
node lib/report.mjs debug        # sample the last 7 days
node lib/report.mjs debug 30     # widen the window
```

It prints a contract table, the actual `usage` field-name combinations DSH is emitting, and an event-type histogram — then states plainly whether the assumptions still hold.

This exists because the author of this tool once ran it against a build where the contract had silently shifted, and the self-check caught it. Use it first whenever numbers look wrong.

## Known fragilities

| Symptom | Likely cause | Where to look |
|---|---|---|
| `debug` reports `MISS` on "能解出事件" | frame layout or compression changed | the frame-splitting code in `report.mjs` |
| Hit rate is flat 0% | `cacheReadTokens` renamed or dropped | `debug` usage composition table |
| `/cache-report tools` says no toolset found | `request/header` payload reshaped | `debug` contract table |
| Attribution is always `session-start` | marker event types renamed | `debug` event histogram |
| Command missing from the `/` panel | `commands.register` contract changed | DSH plugin load errors; check `cordis.yml` resolved the loader entry |
| `/cache-report` returns nothing | engine path wrong | set `DSH_CACHE_REPORT_SCRIPT` to an explicit path |

## Releasing

1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
2. Commit, then tag and push:
   ```bash
   git tag -a vX.Y.Z -m "dsh-cache-report vX.Y.Z"
   git push origin main --tags
   ```
3. Optionally create a GitHub Release from the tag (the web UI offers it on the tag page).

Windows users in the repo may use `push-to-github.bat` (gitignored, local convenience only — it is not part of the published package).

Version pinning for consumers: `dsh plugin --profile web add github:OWNER/dsh-cache-report#vX.Y.Z`.

## Scope and non-goals

**In scope:** reading local usage numbers and the tool table; attributing recomputes; estimating tool-block cost.

**Deliberately out of scope:**

- No network calls, ever. The tool must stay auditable by reading it.
- No conversation content in output. `tools` prints tool *names* only. If you add a subcommand, preserve this property.
- No writing to DSH config, no daemon, no state files. Uninstalling means deleting a directory.
- Not a token *counter* — it reports what DSH already recorded, not what it should have been.

## If you only have five minutes

Run `node lib/report.mjs debug`. If it says "全部命中", the tool works and you can stop. If not, the failing line names the exact contract that moved.
