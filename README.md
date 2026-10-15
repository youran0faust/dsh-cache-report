# dsh-cache-report

> **命中率从 96% 掉到 80%，是谁吃的？**

DSH（DeepSeek Harness）提示缓存命中率与工具块成本报表。一条命令告诉你：今天的 token 花在哪、哪次操作最贵、哪个插件在占位。

> 中文 | [English](README.en.md) · MIT · 零运行时依赖

## 它回答什么问题

大模型的输入分「命中缓存」和「未命中」两种价钱（DeepSeek 官方约 **1 : 10**）。缓存按**前缀**精确匹配，而请求的排布是：

```
[工具定义]   ← 一变，后面全部作废
[系统提示]
[历史消息…]  ← 缓存主要靠这里
[本轮新内容] ← 只有这里应该按未命中计费
```

于是：**在长会话中途装一个插件、启停一个组件、切一次权限档，工具定义就变了——此后整段上下文（系统提示 + 全部历史）会按全价重算一遍。**

多数人只看到命中率掉了，却不知道是谁吃的。这个工具就是回答这个的。

## 安装

前置：DSH（`@deepseek-ai/dsh`）+ Node.js ≥ 20。

### 方式 A：作为 DSH 插件（推荐）

```bash
dsh plugin --profile web add github:youran0faust/dsh-cache-report#main
```

重启 DSH（或依赖 profile 的 `patchReload: live` 热加载），然后在会话输入框打：

```
/cache-report
```

**它只注册斜杠命令、不注册任何工具**——因此**不改变工具表、不会破坏你自己的缓存**。常驻零成本。

### 方式 B：独立脚本（不需要插件机制）

```bash
git clone https://github.com/youran0faust/dsh-cache-report.git
node dsh-cache-report/lib/report.mjs today
```

零运行时依赖，只用 Node 内置模块（`node:fs` / `node:path` / `node:zlib` / `node:os`）。

## 命令

| 输入 | 作用 |
|---|---|
| `/cache-report` | 不带参数 = `today`：今天的命中率 + 大额重算归因 |
| `/cache-report days 7` | 近 7 天趋势表 |
| `/cache-report tools 30` | 工具块成本 / 按插件拆分 / 从未被调用的死重 |
| `/cache-report before-after 24` | 近 24 小时：工具表变化时间线 + 重算代价 + 真实台账花费 |
| `/cache-report help` | 用法 |

独立脚本用法相同：`node lib/report.mjs days 7`。

## 示例输出

> 以下数字为**示意**，用于展示输出形状。

```
$ /cache-report days 7

# 近 7 天缓存趋势（扫描 96 个会话文件）

日期          请求    命中率      未命中tok       命中tok   大额重算   归因Top
2026-10-09     412    95.8%       1,204,331    27,461,882       12   compaction 41%
2026-10-10     688    96.1%       1,988,204    48,932,110       19   compaction 52%
2026-10-11     903    95.4%       2,741,558    56,880,231       27   compaction 47%
2026-10-12     744    94.9%       2,105,772    39,204,118       22   compaction 55%
2026-10-13     611    92.3%       3,388,901    40,612,447       38   compaction 58%
2026-10-14     402    79.5%       6,120,338    23,742,905       61   compaction 74%
2026-10-15     288    73.6%       4,884,120    13,618,442       44   toolset-change 48%
```

拐点出现在 10-14，而且**归因换了人**：从 `compaction`（历史压缩）变成 `toolset-change`（工具表变化）——那正是当天连装了几个插件的日子。

```
$ /cache-report tools

来源               工具数      tok    占比   其中从未调用
  agent-teams           14    4,508   24.9%   ~4,407 tok
  host-core             21    4,308   23.8%   ~224 tok
  dsh-mnemon            17    3,579   19.8%   ~1,315 tok
  dsh-ops                5    2,056   11.4%   ~378 tok
  dsh-undo-savepoint    15    1,936   10.7%   ~1,557 tok
  shell/job              4    1,151    6.4%   -
  modsearch              4      520    2.9%   ~190 tok

## 从未被调用（共 37 个 / ~8,071 tok）
  ~  790 tok  agent_teams_create_task          agent-teams
  ~  752 tok  agent_teams_update_task          agent-teams
  ...
```

## 怎么读：命中率是**比率陷阱**

**命中率 = 命中 / (命中 + 未命中)**。但**别只盯比率**——它会被上下文长度稀释或放大：

| | 命中率 | 每次请求 token | 实际花销 |
|---|---|---|---|
| 长会话 | 96% | 190k | 高 |
| 短会话 | 80% | 148k | **更低** |

比率掉了，账单可能反而降了。**真正该看的是「未命中 token 的绝对值」**，那才是按全价计费的部分。

工具把「单请求未命中 ≥ 5 万 token」（阈值 `DSH_REPORT_BIG` 可调）的事件称为**大额重算**，并按原因归类：

| 归因 | 含义 | 你能控制吗 |
|---|---|---|
| `toolset-change` | 装/卸插件、启停组件、切权限档 | ✅ **能** —— 攒着一起改，改完开新会话 |
| `compaction` | 历史压缩（长会话的必然代价） | ⚠️ 半能 —— 会话别拖太长 |
| `session-start` | 新会话冷启动 | ⛔ 正常开销 |
| `resume` | 恢复旧会话 | ⛔ 正常开销 |

### 三条实用规则

1. **插件攒着一起装，装完开新会话。** 中途装一个，当前会话的历史就得全价重算一遍。
2. **别在长会话里切模型 / 切权限档。** 同理，都在改前缀。
3. **看未命中 token 的绝对值，不看百分比。**

## 数据来源与隐私

读的是本机 DSH 会话日志：`$DSH_HOME/sessions/` 下的 `session.v*.jsonl.zstd`（多帧 zstd，脚本按魔数切帧逐帧解）。

只用其中的**用量数字**与**工具表**：

- `assistant/message` → `usage.inputTokens`（未命中）/ `usage.cacheReadTokens`（命中）
- `request/header` → 当时的工具定义列表 + `reason`（`initial` / `series` / `resume` / `change`）

**不会打印任何对话内容、文件内容或密钥**；`tools` 只输出工具**名字**。所有计算在本机完成，**不联网、不上传**。

## 局限（诚实说明）

- **token 数是估算**：工具表按 `ASCII字符/4 + 非ASCII字符/1.5` 估算，误差约 ±10%。
- **归因是启发式的**：按「大额重算之前最近的一个原因事件」判定，压缩与工具表变化挨得近时可能归错。
- **只覆盖能观测到的**：读的是 DSH 落盘的会话日志，未落盘或被清理的会话不计入。
- **zstd 依赖 Node ≥ 22.15**（`node:zlib` 的 zstd API）。更低的 Node 会报错。

## 卸载

```bash
dsh plugin --profile web remove dsh-cache-report
```

独立脚本直接删目录即可。它不写任何配置、不常驻进程、不留状态。

## 开发

```bash
node lib/report.mjs help        # 自检
node lib/report.mjs days 2      # 快速冒烟
```

## License

MIT
