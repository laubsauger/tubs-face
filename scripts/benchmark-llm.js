#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { loadEnvFile } = require('../src/env');

loadEnvFile(path.join(__dirname, '..', '.env'));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [k, inlineV] = arg.slice(2).split('=');
    if (inlineV !== undefined) {
      out[k] = inlineV;
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[k] = next;
      i += 1;
    } else {
      out[k] = true;
    }
  }
  return out;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function summarize(values) {
  if (!values.length) {
    return { n: 0, mean: 0, p50: 0, p95: 0, min: 0, max: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((acc, n) => acc + n, 0);
  return {
    n: values.length,
    mean: sum / values.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

function fmtMs(n) {
  return `${Math.round(n)}ms`;
}

function defaultSystemInstruction() {
  const promptPath = path.join(__dirname, '..', 'src', 'persona', 'system-prompt.txt');
  try {
    return fs.readFileSync(promptPath, 'utf8').trim();
  } catch {
    return 'You are a concise assistant. Respond in plain spoken English in 1-2 short sentences.';
  }
}

function buildCases() {
  const longBody = [
    'I am trying to decide between setting this up for a gallery installation, a live stream, and an event booth.',
    'The booth has noisy audio, occasional cross-talk, and a lot of interruptions.',
    'I care about responsiveness, personality consistency, and keeping users engaged.',
    'Please consider tradeoffs around latency, reliability, and complexity.',
    'I also need practical advice for what to measure and how to compare models consistently over multiple runs.',
    'Finally, include any caveats about prompt structure, token pressure, and structured output reliability.',
  ].join(' ');

  return [
    {
      id: 'short',
      text: 'Give one practical tip to reduce voice-assistant latency.',
    },
    {
      id: 'medium',
      text: 'I am tuning a realtime voice assistant. What are the top three levers to improve response speed while keeping good answer quality?',
    },
    {
      id: 'long',
      text: longBody,
    },
  ];
}

async function httpJson(url, payload, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const raw = await res.text();
    let json = null;
    try {
      json = JSON.parse(raw);
    } catch {
      json = null;
    }
    if (!res.ok) {
      const detail = json?.error || json?.message || raw.slice(0, 300) || `HTTP ${res.status}`;
      const err = new Error(`${res.status} ${detail}`);
      err.status = res.status;
      throw err;
    }
    return json || {};
  } finally {
    clearTimeout(timer);
  }
}

async function benchDirectOllama({ model, userText, systemInstruction, baseUrl, timeoutMs, maxTokens, temperature }) {
  const t0 = performance.now();
  const json = await httpJson(`${baseUrl}/api/chat`, {
    model,
    stream: false,
    options: {
      temperature,
      num_predict: maxTokens,
    },
    messages: [
      { role: 'system', content: systemInstruction },
      { role: 'user', content: userText },
    ],
  }, timeoutMs);
  const t1 = performance.now();
  const text = String(json?.message?.content || '').trim();
  return {
    latencyMs: t1 - t0,
    textChars: text.length,
    usageIn: Number(json?.prompt_eval_count || 0),
    usageOut: Number(json?.eval_count || 0),
    model: String(json?.model || model),
  };
}

async function benchRealtimeApi({ model, userText, systemInstruction, baseUrl, timeoutMs, maxTokens, temperature }) {
  const t0 = performance.now();
  const json = await httpJson(`${baseUrl}/llm/generate`, {
    model,
    systemInstruction,
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    maxOutputTokens: maxTokens,
    temperature,
    timeoutMs,
  }, timeoutMs + 1000);
  const t1 = performance.now();
  const text = String(json?.text || '').trim();
  return {
    latencyMs: t1 - t0,
    textChars: text.length,
    usageIn: Number(json?.usage?.promptTokenCount || 0),
    usageOut: Number(json?.usage?.candidatesTokenCount || 0),
    model: String(json?.model || model),
  };
}

let assistantLoaded = false;
let runtimeConfig = null;
let clearAssistantContext = null;
let generateAssistantReply = null;

function ensureAssistantLoaded() {
  if (assistantLoaded) return;
  process.env.PROCESSING_MODE = 'realtime';
  ({ runtimeConfig } = require('../src/config'));
  ({ clearAssistantContext } = require('../src/assistant/context'));
  ({ generateAssistantReply } = require('../src/assistant/generate'));
  assistantLoaded = true;
}

async function benchAssistantPipeline({ model, userText, maxTokens, temperature }) {
  ensureAssistantLoaded();
  runtimeConfig.processingMode = 'realtime';
  runtimeConfig.llmModel = model;
  runtimeConfig.llmMaxOutputTokens = maxTokens;
  clearAssistantContext('benchmark');

  const t0 = performance.now();
  const reply = await generateAssistantReply(userText, {
    temperature,
  });
  const t1 = performance.now();
  const text = String(reply?.text || '').trim();
  return {
    latencyMs: t1 - t0,
    pipelineLatencyMs: Number(reply?.latencyMs || 0),
    textChars: text.length,
    usageIn: Number(reply?.tokens?.in || 0),
    usageOut: Number(reply?.tokens?.out || 0),
    model: String(reply?.model || model),
    source: String(reply?.source || ''),
  };
}

function keyFor(result) {
  return `${result.target}||${result.model}||${result.caseId}`;
}

function printSummary(rows, runs) {
  const grouped = new Map();
  for (const row of rows) {
    const key = keyFor(row);
    if (!grouped.has(key)) {
      grouped.set(key, {
        target: row.target,
        model: row.model,
        caseId: row.caseId,
        latencies: [],
        textChars: [],
        errors: [],
      });
    }
    const bucket = grouped.get(key);
    if (row.error) {
      bucket.errors.push(row.error);
    } else {
      bucket.latencies.push(row.latencyMs);
      bucket.textChars.push(row.textChars || 0);
    }
  }

  const table = [];
  for (const bucket of grouped.values()) {
    const s = summarize(bucket.latencies);
    const chars = summarize(bucket.textChars);
    table.push({
      target: bucket.target,
      model: bucket.model,
      caseId: bucket.caseId,
      ok: s.n,
      err: bucket.errors.length,
      meanMs: s.mean,
      p50Ms: s.p50,
      p95Ms: s.p95,
      minMs: s.min,
      maxMs: s.max,
      avgChars: chars.mean,
    });
  }

  table.sort((a, b) => {
    if (a.target !== b.target) return a.target.localeCompare(b.target);
    if (a.model !== b.model) return a.model.localeCompare(b.model);
    return a.caseId.localeCompare(b.caseId);
  });

  console.log('');
  console.log(`Benchmark summary (runs=${runs})`);
  console.log('target | model | case | ok | err | mean | p50 | p95 | min | max | avg chars');
  console.log('---|---|---|---:|---:|---:|---:|---:|---:|---:|---:');
  for (const row of table) {
    console.log([
      row.target,
      row.model,
      row.caseId,
      row.ok,
      row.err,
      fmtMs(row.meanMs),
      fmtMs(row.p50Ms),
      fmtMs(row.p95Ms),
      fmtMs(row.minMs),
      fmtMs(row.maxMs),
      Math.round(row.avgChars),
    ].join(' | '));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runsRaw = Number.parseInt(String(args.runs ?? '3'), 10);
  const warmupRaw = Number.parseInt(String(args.warmup ?? '1'), 10);
  const runs = Math.max(1, Number.isFinite(runsRaw) ? runsRaw : 3);
  const warmup = Math.max(0, Number.isFinite(warmupRaw) ? warmupRaw : 1);
  const timeoutMs = Math.max(1000, Number.parseInt(String(args.timeout_ms || '45000'), 10) || 45000);
  const maxTokens = Math.max(32, Number.parseInt(String(args.max_tokens || '256'), 10) || 256);
  const temperature = Number.isFinite(Number(args.temperature)) ? Number(args.temperature) : 0.2;
  const ollamaBaseUrl = String(args.ollama_url || process.env.REALTIME_LLM_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const realtimeBaseUrl = String(args.realtime_url || `http://127.0.0.1:${process.env.REALTIME_PROCESSING_PORT || 3002}`).replace(/\/$/, '');
  const modeArg = String(args.target || 'all').trim().toLowerCase();
  const allTargets = ['ollama', 'realtime', 'assistant'];
  const targets = modeArg === 'all'
    ? allTargets
    : modeArg.split(',').map((s) => s.trim()).filter(Boolean);
  const models = String(args.models || process.env.REALTIME_LLM_MODEL || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!models.length) {
    throw new Error('No models provided. Pass --models modelA,modelB or set REALTIME_LLM_MODEL.');
  }

  const systemInstruction = defaultSystemInstruction();
  const cases = buildCases();
  const rows = [];

  console.log(`Targets: ${targets.join(', ')}`);
  console.log(`Models: ${models.join(', ')}`);
  console.log(`Cases: ${cases.map((c) => c.id).join(', ')}`);
  console.log(`Warmup: ${warmup}, Runs: ${runs}, Timeout: ${timeoutMs}ms`);

  for (const target of targets) {
    if (!allTargets.includes(target)) {
      throw new Error(`Unknown target "${target}" (use ollama,realtime,assistant,all).`);
    }
  }

  async function runOne(target, model, c, phaseLabel) {
    const tag = `[${phaseLabel}] ${target} ${model} ${c.id}`;
    const started = performance.now();
    try {
      let result;
      if (target === 'ollama') {
        result = await benchDirectOllama({
          model,
          userText: c.text,
          systemInstruction,
          baseUrl: ollamaBaseUrl,
          timeoutMs,
          maxTokens,
          temperature,
        });
      } else if (target === 'realtime') {
        result = await benchRealtimeApi({
          model,
          userText: c.text,
          systemInstruction,
          baseUrl: realtimeBaseUrl,
          timeoutMs,
          maxTokens,
          temperature,
        });
      } else {
        result = await benchAssistantPipeline({
          model,
          userText: c.text,
          maxTokens,
          temperature,
        });
      }
      const elapsed = performance.now() - started;
      console.log(`${tag} -> ${fmtMs(elapsed)} (${result.textChars || 0} chars)`);
      rows.push({
        phase: phaseLabel,
        target,
        model,
        caseId: c.id,
        latencyMs: elapsed,
        textChars: result.textChars || 0,
        usageIn: result.usageIn || 0,
        usageOut: result.usageOut || 0,
        source: result.source || null,
        pipelineLatencyMs: result.pipelineLatencyMs || null,
        resolvedModel: result.model || model,
      });
    } catch (err) {
      const elapsed = performance.now() - started;
      console.log(`${tag} -> ERROR ${fmtMs(elapsed)} ${err.message}`);
      rows.push({
        phase: phaseLabel,
        target,
        model,
        caseId: c.id,
        latencyMs: elapsed,
        error: err.message,
      });
    }
  }

  for (let i = 0; i < warmup; i += 1) {
    for (const target of targets) {
      for (const model of models) {
        for (const c of cases) {
          await runOne(target, model, c, `warmup-${i + 1}`);
        }
      }
    }
  }

  for (let i = 0; i < runs; i += 1) {
    for (const target of targets) {
      for (const model of models) {
        for (const c of cases) {
          await runOne(target, model, c, `run-${i + 1}`);
        }
      }
    }
  }

  printSummary(rows.filter((r) => String(r.phase || '').startsWith('run-')), runs);

  if (args.out_json) {
    const outPath = path.resolve(String(args.out_json));
    fs.writeFileSync(outPath, JSON.stringify({
      generatedAt: new Date().toISOString(),
      args: {
        runs,
        warmup,
        timeoutMs,
        maxTokens,
        temperature,
        targets,
        models,
        ollamaBaseUrl,
        realtimeBaseUrl,
      },
      rows,
    }, null, 2));
    console.log(`Wrote raw results: ${outPath}`);
  }
}

main().catch((err) => {
  console.error(`Benchmark failed: ${err.message}`);
  process.exitCode = 1;
});
