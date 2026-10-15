#!/usr/bin/env node
/**
 * dsh-cache-report — DSH 提示缓存命中率 / 工具块成本报表
 *
 * 零依赖：只用 node:fs / node:path / node:zlib / node:os
 * 数据源：$DSH_HOME/sessions 下的 session.v*.jsonl.zstd（递归）
 *   - assistant/message .data.usage {inputTokens(未命中), cacheReadTokens(命中), outputTokens}
 *   - request/header .data.{header.tools[], reason}   reason: initial|series|resume|change
 *   - compaction/end, model/selection, sandbox/mode, permission/preset
 * 注：会话文件是多帧 zstd，zstdDecompressSync 只解第一帧，故按魔数 28 B5 2F FD 切帧逐帧解。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { homedir } from 'node:os'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const BIG = Number(process.env.DSH_REPORT_BIG || 50000)
const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const SESSIONS = join(HOME, 'sessions')
const USAGE = join(HOME, '.dshw-usage.json')

const argv = process.argv.slice(2)
const cmd = (argv[0] || 'today').toLowerCase()
const asJson = argv.includes('--json')
const numArg = (i, d) => { const v = Number(argv[i]); return Number.isFinite(v) && v > 0 ? v : d }

// ---------- 基础工具 ----------
function listFiles(root, sinceMs) {
  const out = []
  const walk = (dir) => {
    let ents
    try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.jsonl.zstd')) {
        try { const st = statSync(p); if (!sinceMs || st.mtimeMs >= sinceMs) out.push({ p, m: st.mtimeMs }) } catch {}
      }
    }
  }
  walk(root)
  return out.sort((a, b) => a.m - b.m)
}

/** 逐帧解压并产出事件对象（不保留整文件文本） */
function eachEvent(file, fn) {
  let buf
  try { buf = readFileSync(file) } catch { return 0 }
  const offs = []
  let i = 0
  while (true) { const k = buf.indexOf(MAGIC, i); if (k < 0) break; offs.push(k); i = k + 1 }
  let n = 0
  for (let m = 0; m < offs.length; m++) {
    const s = offs[m], e = m + 1 < offs.length ? offs[m + 1] : buf.length
    let text
    try { text = zstdDecompressSync(buf.subarray(s, e)).toString('utf8') } catch { continue }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let j
      try { j = JSON.parse(line) } catch { continue }
      if (typeof j.time !== 'number') continue
      n++
      fn(j)
    }
  }
  return n
}

const dayOf = (ms) => new Date(ms).toLocaleDateString('sv-SE')          // YYYY-MM-DD 本地
const hms = (ms) => new Date(ms).toLocaleTimeString('sv-SE')
function estimateTokens(text) {
  let ascii = 0, other = 0
  for (const ch of text) { if (ch.codePointAt(0) < 128) ascii++; else other++ }
  return Math.round(ascii / 4 + other / 1.5)
}
const pct = (x) => (x * 100).toFixed(1) + '%'
const pad = (s, n) => String(s).padStart(n)
const ownerOf = (name) =>
  name.startsWith('ops_') ? 'dsh-ops'
  : name.startsWith('mnemon_') ? 'dsh-mnemon'
  : name.startsWith('undo_') ? 'dsh-undo-savepoint'
  : name.startsWith('agent_teams') ? 'agent-teams'
  : (name.startsWith('web_') || name.startsWith('x_') || name === 'read_page') ? 'modsearch'
  : (name === 'bash' || name === 'pwsh' || name.startsWith('job_')) ? 'shell/job'
  : 'host-core'

// ---------- 扫描与聚合 ----------
function scan(days, wantTools) {
  const cut = days ? Date.now() - days * 86400000 : 0
  const files = listFiles(SESSIONS, cut ? cut - 2 * 86400000 : 0)
  const byDay = new Map()
  const toolsets = new Map()
  const called = new Map()
  let events = 0
  for (const { p } of files) {
    let lastCause = 'session-start'
    events += eachEvent(p, (j) => {
      const t = j.type
      if (t === 'compaction/end') { lastCause = 'compaction'; return }
      if (t === 'model/selection') { lastCause = 'model-switch'; return }
      if (t === 'permission/preset') { lastCause = 'permission-preset'; return }
      if (t === 'request/header') {
        const d = j.data || {}
        const r = d.reason || '?'
        if (r === 'change') lastCause = 'toolset-change'
        else if (r === 'resume') lastCause = 'resume'
        else if (r === 'initial') lastCause = 'session-start'
        const tools = (d.header && d.header.tools) || []
        if (wantTools && tools.length > 0) {
          const cur = toolsets.get(tools.length)
          if (!cur || j.time > cur.time) toolsets.set(tools.length, { time: j.time, tools })
        }
        return
      }
      if (t === 'tool/call') {
        const n = (j.data && (j.data.name || j.data.tool)) || null
        if (n) called.set(n, (called.get(n) || 0) + 1)
        return
      }
      if (t !== 'assistant/message') return
      const u = j.data && j.data.usage
      if (!u) return
      if (cut && j.time < cut) return
      const inp = Number(u.inputTokens || 0), ca = Number(u.cacheReadTokens || 0), out = Number(u.outputTokens || 0)
      const day = dayOf(j.time)
      let d = byDay.get(day)
      if (!d) { d = { n: 0, inp: 0, ca: 0, out: 0, causes: new Map(), resets: [] }; byDay.set(day, d) }
      d.n++; d.inp += inp; d.ca += ca; d.out += out
      if (inp >= BIG) {
        const c = d.causes.get(lastCause) || { n: 0, tok: 0 }
        c.n++; c.tok += inp
        d.causes.set(lastCause, c)
        if (d.resets.length < 10) d.resets.push({ time: j.time, inp, cause: lastCause })
      }
    })
  }
  return { files: files.length, events, byDay, toolsets, called }
}

const rate = (d) => { const t = d.inp + d.ca; return t > 0 ? d.ca / t : 0 }

// ---------- 报表 ----------
function reportToday(days) {
  const rep = scan(days, false)
  const today = dayOf(Date.now())
  const d = rep.byDay.get(today)
  if (!d) { console.log(`今天（${today}）还没有用量记录。`); return }
  console.log(`# 缓存报表 · ${today}`)
  console.log(`扫描 ${rep.files} 个会话文件 / ${rep.events.toLocaleString()} 个事件\n`)
  console.log(`请求数        ${d.n.toLocaleString()}`)
  console.log(`未命中 token  ${d.inp.toLocaleString()}`)
  console.log(`命中 token    ${d.ca.toLocaleString()}`)
  console.log(`输出 token    ${d.out.toLocaleString()}`)
  console.log(`命中率        ${pct(rate(d))}   （命中 / (命中+未命中)）`)
  const causes = [...d.causes.entries()].sort((a, b) => b[1].tok - a[1].tok)
  const totReset = causes.reduce((a, [, v]) => a + v.tok, 0)
  console.log(`\n## 大额重算归因（单请求未命中 ≥ ${BIG.toLocaleString()}）`)
  if (!causes.length) console.log('  无')
  for (const [k, v] of causes) {
    const share = d.inp > 0 ? (v.tok / d.inp) * 100 : 0
    console.log(`  ${k.padEnd(18)} ${pad(v.n, 4)} 次  ${pad(v.tok.toLocaleString(), 12)} tok   占当天未命中 ${share.toFixed(1)}%`)
  }
  if (totReset > 0 && d.inp > 0) console.log(`  → 合计占当天未命中 ${((totReset / d.inp) * 100).toFixed(1)}%`)
  if (d.resets.length) {
    console.log('\n## 最近的大额重算')
    for (const r of d.resets.slice(-10)) console.log(`  ${hms(r.time)}  ${pad(r.inp.toLocaleString(), 9)} tok  ${r.cause}`)
  }
}

function reportDays(n) {
  const rep = scan(n, false)
  const rows = [...rep.byDay.entries()].sort()
  if (!rows.length) { console.log('窗口内没有用量记录。'); return }
  console.log(`# 近 ${n} 天缓存趋势（扫描 ${rep.files} 个会话文件）\n`)
  console.log('日期          请求    命中率      未命中tok        命中tok  大额重算   归因Top')
  for (const [day, d] of rows) {
    const causes = [...d.causes.entries()].sort((a, b) => b[1].tok - a[1].tok)
    const nReset = causes.reduce((a, [, v]) => a + v.n, 0)
    const top = causes.length ? `${causes[0][0]} ${((causes[0][1].tok / (d.inp || 1)) * 100).toFixed(0)}%` : '-'
    console.log(`${day}  ${pad(d.n.toLocaleString(), 6)}  ${pad(pct(rate(d)), 7)}  ${pad(d.inp.toLocaleString(), 14)}  ${pad(d.ca.toLocaleString(), 13)}  ${pad(nReset, 7)}   ${top}`)
  }
  const t = rows.reduce((a, [, d]) => ({ inp: a.inp + d.inp, ca: a.ca + d.ca, n: a.n + d.n }), { inp: 0, ca: 0, n: 0 })
  console.log(`\n合计        ${pad(t.n.toLocaleString(), 6)}  ${pad(pct(t.ca / (t.ca + t.inp)), 7)}  ${pad(t.inp.toLocaleString(), 14)}  ${pad(t.ca.toLocaleString(), 13)}`)
}

function reportTools(days) {
  const rep = scan(days, true)
  let best = null
  for (const v of rep.toolsets.values()) if (!best || v.tools.length > best.tools.length) best = v
  if (!best) { console.log('没找到工具表记录。'); return }
  const tools = best.tools
  const full = JSON.stringify(tools)
  const owners = new Map()
  let deadTok = 0, deadN = 0
  const dead = [], rare = []
  for (const t of tools) {
    const sz = JSON.stringify(t).length
    const tok = estimateTokens(JSON.stringify(t))
    const c = rep.called.get(t.name) || 0
    const o = owners.get(ownerOf(t.name)) || { n: 0, tok: 0, dead: 0 }
    o.n++; o.tok += tok
    if (c === 0) { o.dead += tok; deadTok += tok; deadN++; dead.push({ name: t.name, tok, owner: ownerOf(t.name) }) }
    else if (c < 15) rare.push({ name: t.name, tok, c, owner: ownerOf(t.name) })
    owners.set(ownerOf(t.name), o)
  }
  console.log(`# 工具块成本（取历史最大工具表，${new Date(best.time).toLocaleString('sv-SE')}）\n`)
  console.log(`工具数     ${tools.length}`)
  console.log(`序列化长度 ${full.length.toLocaleString()} 字符`)
  console.log(`估算 token ${estimateTokens(full).toLocaleString()}   （ASCII/4 + 非ASCII/1.5，误差约 ±10%）\n`)
  console.log('来源               工具数      tok    占比   其中从未调用')
  for (const [k, v] of [...owners.entries()].sort((a, b) => b[1].tok - a[1].tok)) {
    console.log(`  ${k.padEnd(18)} ${pad(v.n, 5)}  ${pad(v.tok.toLocaleString(), 7)}  ${pad(((v.tok / estimateTokens(full)) * 100).toFixed(1) + '%', 6)}   ${v.dead ? '~' + v.dead.toLocaleString() + ' tok' : '-'}`)
  }
  console.log(`\n## 从未被调用（自 2026-09-18 起，共 ${deadN} 个 / ~${deadTok.toLocaleString()} tok）`)
  for (const x of dead.sort((a, b) => b.tok - a.tok)) console.log(`  ~${pad(x.tok, 5)} tok  ${x.name.padEnd(32)} ${x.owner}`)
  console.log(`\n## 调用 <15 次（${rare.length} 个）`)
  for (const x of rare.sort((a, b) => b.tok - a.tok)) console.log(`  ${pad(x.c, 4)}x  ~${pad(x.tok, 5)} tok  ${x.name.padEnd(32)} ${x.owner}`)
  console.log('\n提示：工具定义在请求最前面，缓存命中时几乎免费；贵的是「它变化的那一刻」。')
}

function reportBeforeAfter(hours) {
  const days = Math.max(1, Math.ceil(hours / 24))
  const rep = scan(days, true)
  const cut = Date.now() - hours * 3600000
  console.log(`# 近 ${hours} 小时：工具表变化与大额重算\n`)
  console.log('## 工具表时间线（按工具数）')
  for (const [size, v] of [...rep.toolsets.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  ${pad(size, 3)} 个工具   ${new Date(v.time).toLocaleString('sv-SE')}`)
  }
  let changeN = 0, changeTok = 0
  for (const [, d] of rep.byDay) for (const [k, v] of d.causes) if (k === 'toolset-change') { changeN += v.n; changeTok += v.tok }
  console.log(`\n## 归因给「工具表变化」的大额重算（窗口内全部）`)
  console.log(`  ${changeN} 次  ${changeTok.toLocaleString()} tok`)
  if (existsSync(USAGE)) {
    try {
      const u = JSON.parse(readFileSync(USAGE, 'utf8'))
      const ev = (u.events || []).filter((e) => e.ts >= cut)
      const tok = ev.reduce((a, e) => a + (e.tokens || 0), 0)
      const cost = ev.reduce((a, e) => a + (e.cost || 0), 0)
      if (tok > 0) console.log(`\n## 同期实际用量（来自 .dshw-usage.json 台账）\n  ${ev.length} 笔  ${tok.toLocaleString()} tok  花掉 ${cost.toFixed(4)}（混合均价 ${(cost / tok * 1e6).toFixed(3)} / 百万 tok）`)
    } catch {}
  }
}


function reportDebug(days) {
  const cut = days ? Date.now() - days * 86400000 : 0
  const files = listFiles(SESSIONS, cut ? cut - 2 * 86400000 : 0)
  const types = new Map()
  const keySets = new Map()
  let bestSample = null, total = 0, usageTotal = 0, withCache = 0, decodeFail = 0, headerSample = null
  const has = (o, k) => o && Object.prototype.hasOwnProperty.call(o, k)
  const sampleFiles = files.slice(-60)
  for (const { p } of sampleFiles) {
    const n = eachEvent(p, (j) => {
      total++
      types.set(j.type, (types.get(j.type) || 0) + 1)
      if (j.type === 'assistant/message' && j.data && j.data.usage) {
        const u = j.data.usage
        usageTotal++
        const sig = Object.keys(u).sort().join(', ')
        keySets.set(sig, (keySets.get(sig) || 0) + 1)
        if (has(u, 'cacheReadTokens')) {
          withCache++
          if (!bestSample || Object.keys(u).length > Object.keys(bestSample).length) bestSample = u
        }
      }
      if (!headerSample && j.type === 'request/header' && j.data && j.data.header) headerSample = j.data
    })
    if (n === 0) decodeFail++
  }
  const mark = (ok) => (ok ? 'OK  ' : 'MISS')
  const u = bestSample || {}
  const h = headerSample || {}
  const tools = (h.header && h.header.tools) || []
  console.log('# 格式自检（debug）')
  console.log()
  console.log(`DSH_HOME       ${HOME}`)
  console.log(`sessions root  ${SESSIONS}`)
  console.log(`会话文件       共 ${files.length} 个，抽样最后 ${sampleFiles.length} 个`)
  console.log(`解出事件       ${total.toLocaleString()}    解码失败文件 ${decodeFail}`)
  console.log()
  console.log('## 数据契约检查（DSH 内部格式；升级 DSH 后先看这里）')
  console.log(`  ${mark(total > 0)}  能解出事件（多帧 zstd 切帧正常）`)
  console.log(`  ${mark(usageTotal > 0)}  assistant/message 带 usage                    （${usageTotal} 条）`)
  console.log(`  ${mark(withCache > 0)}  usage.cacheReadTokens（命中）                  （${withCache} / ${usageTotal} 条带它）`)
  console.log(`      usage.inputTokens（未命中）                  ${has(u, 'inputTokens') ? '有' : '缺'}`)
  console.log(`      usage.outputTokens                           ${has(u, 'outputTokens') ? '有' : '缺'}`)
  console.log(`  ${mark(tools.length > 0)}  request/header.data.header.tools              （工具表，${tools.length} 个）`)
  console.log(`  ${mark(has(h, 'reason'))}  request/header.data.reason                    （${has(h, 'reason') ? JSON.stringify(h.reason) : '缺失'}）`)
  console.log()
  console.log('## usage 字段组合分布')
  console.log('   （子代理/后台请求可能没有 cacheReadTokens，属正常，不是格式损坏）')
  for (const [sig, n] of [...keySets.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pad(n.toLocaleString(), 9)}  ${sig}${sig.includes('cacheReadTokens') ? '' : '   <- 无缓存字段'}`)
  }
  console.log()
  console.log('## 事件类型分布（按次数，前 25）')
  for (const [k, v] of [...types.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    console.log(`  ${pad(v.toLocaleString(), 10)}  ${k}`)
  }
  console.log()
  const broken = !(total > 0 && usageTotal > 0 && withCache > 0 && tools.length > 0 && has(h, 'reason'))
  console.log(broken
    ? '有项 MISS：DSH 可能改了会话格式。见 MAINTAINING.md 的「已知脆弱点」。'
    : '全部命中：当前 DSH 的会话格式与本文具的假设一致。')
}

// ---------- 入口 ----------
const usage = `dsh-cache-report — DSH 缓存命中率 / 工具块成本报表

用法：
  node dsh-cache-report.mjs today              今天：命中率 + 大额重算归因
  node dsh-cache-report.mjs days [N]           近 N 天趋势（默认 7）
  node dsh-cache-report.mjs tools [N]          工具块成本 / 按插件拆分 / 从未调用的死重
  node dsh-cache-report.mjs before-after [H]   近 H 小时：工具表变化与重算代价（默认 24）
  node dsh-cache-report.mjs debug [N]          格式自检：DSH 会话格式是否仍符合预期
  node dsh-cache-report.mjs help

环境变量：
  DSH_HOME         DSH 家目录（默认 ~/.dsh）
  DSH_REPORT_BIG   「大额重算」阈值，默认 50000 token

读法：命中率 = 命中 / (命中+未命中)。工具定义在请求最前面，
一变就让其后整段（系统提示 + 全部历史）全价重算。`

try {
  if (cmd === 'help' || cmd === '-h' || cmd === '--help') console.log(usage)
  else if (cmd === 'today') reportToday(numArg(1, 3))
  else if (cmd === 'days') reportDays(numArg(1, 7))
  else if (cmd === 'tools') reportTools(numArg(1, 30))
  else if (cmd === 'before-after' || cmd === 'ba') reportBeforeAfter(numArg(1, 24))
  else if (cmd === 'debug') reportDebug(numArg(1, 7))
  else { console.log(`未知命令 "${cmd}"\n`); console.log(usage) }
} catch (e) {
  console.error('出错了：' + ((e && e.stack) || e))
  process.exit(1)
}
