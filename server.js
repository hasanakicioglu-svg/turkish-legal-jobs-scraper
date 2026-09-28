import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';

const app = express();
const startedAt = new Date().toISOString();
const runs = new Map();
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'https://hasan-legal-radar-tr.hasan-akicioglu.chatgpt.site')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const SEARCH_TIMEOUT_MS = Number(process.env.SEARCH_TIMEOUT_MS || 60000);

const queryPlan = [
  { id: 'tr-linkedin-legal', geography: 'Türkiye', source: 'LinkedIn / indexed web', query: 'site:linkedin.com/jobs Turkey legal counsel OR legal manager OR hukuk müdürü OR hukuk müşaviri' },
  { id: 'tr-kariyer-legal', geography: 'Türkiye', source: 'Kariyer.net / indexed web', query: 'site:kariyer.net/is-ilani hukuk müdürü OR hukuk müşaviri OR legal counsel OR legal manager' },
  { id: 'tr-contracts', geography: 'Türkiye', source: 'indexed web', query: 'Turkey "Manager - Contract" OR "Contracts Manager" OR "Commercial & Contracts Manager" legal regulatory compliance' },
  { id: 'gcc-legal-leadership', geography: 'GCC', source: 'LinkedIn / indexed web', query: 'Saudi UAE Qatar Kuwait Oman Bahrain legal director OR general counsel OR head of legal' },
  { id: 'gcc-contracts', geography: 'GCC', source: 'LinkedIn / indexed web', query: 'Dubai Riyadh Doha "Manager - Contract" OR "Contracts Manager" dispute resolution contractual risk' },
  { id: 'global-legal-ai', geography: 'Global / Remote', source: 'indexed web', query: 'legal engineer OR AI counsel OR legal AI product counsel OR legal knowledge engineer remote' }
];

app.use(express.json({ limit: '64kb' }));
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origin not allowed'));
  }
}));

function publicRun(run) {
  return {
    runId: run.runId,
    status: run.status,
    outcome: run.outcome,
    scope: run.scope,
    source: run.source,
    requestedAt: run.requestedAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    progress: run.progress,
    note: run.note,
    blockers: run.blockers,
    findings: run.findings,
    audit: run.audit
  };
}

function setProgress(run, patch) {
  Object.assign(run, patch);
  run.updatedAt = new Date().toISOString();
  runs.set(run.runId, run);
}

function normalizeError(error) {
  if (error?.name === 'TimeoutError' || /aborted due to timeout/i.test(error?.message || '')) {
    return `Search timeout after ${Math.round(SEARCH_TIMEOUT_MS / 1000)}s`;
  }
  return error?.message || 'Unknown search error';
}

async function searchWithSerpApi(task) {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
    return {
      status: 'blocked',
      reason: 'SERPAPI_KEY is not configured on Render. No external search was executed.',
      items: []
    };
  }

  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('engine', 'google');
  url.searchParams.set('q', task.query);
  url.searchParams.set('num', '10');
  url.searchParams.set('api_key', apiKey);

  const response = await fetch(url, { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`SerpAPI HTTP ${response.status}${body ? `: ${body.slice(0, 240)}` : ''}`);
  }

  const data = await response.json();
  if (data.error) throw new Error(`SerpAPI error: ${data.error}`);

  const organic = Array.isArray(data.organic_results) ? data.organic_results : [];
  return {
    status: 'searched',
    reason: null,
    items: organic.slice(0, 10).map((item) => ({
      title: item.title || '',
      link: item.link || '',
      snippet: item.snippet || '',
      source: item.source || task.source
    }))
  };
}

function candidateLooksRelevant(item) {
  const text = `${item.title} ${item.snippet}`.toLowerCase();
  return /(legal|hukuk|avukat|müşavir|counsel|lawyer|contract|contracts|governance|compliance|ai counsel|legal engineer)/i.test(text);
}

function summarizeBlockers(blockers, findings) {
  if (!blockers.length) {
    return 'Manual scan runner completed discovery. Candidates still require verification before dashboard admission.';
  }

  const reasons = [...new Set(blockers.map((blocker) => blocker.reason).filter(Boolean))];
  const missingSerpApi = reasons.some((reason) => /SERPAPI_KEY is not configured/i.test(reason));
  if (missingSerpApi) {
    return 'Manual scan runner is connected, but SERPAPI_KEY is not visible to the running Render service.';
  }

  const timeoutCount = reasons.filter((reason) => /timeout/i.test(reason)).length;
  if (timeoutCount) {
    return findings.length
      ? `Manual scan partially completed. ${timeoutCount} query group timed out; ${findings.length} candidate(s) were still captured for later verification.`
      : `Manual scan reached SerpAPI, but the search provider timed out after ${Math.round(SEARCH_TIMEOUT_MS / 1000)}s. Try again once; if it repeats, reduce query size or increase service timeout.`;
  }

  const providerErrors = reasons.filter((reason) => /SerpAPI/i.test(reason));
  if (providerErrors.length) {
    return `Manual scan runner reached Render, but SerpAPI returned an error: ${providerErrors[0]}`;
  }

  return `Manual scan runner finished with blockers: ${reasons[0] || 'unknown blocker'}`;
}

async function executeRun(runId) {
  const run = runs.get(runId);
  if (!run) return;

  console.log(JSON.stringify({ event: 'manual_scan_started', runId, searchConfigured: Boolean(process.env.SERPAPI_KEY), searchTimeoutMs: SEARCH_TIMEOUT_MS, taskCount: queryPlan.length }));
  setProgress(run, {
    status: 'running',
    outcome: 'partial',
    startedAt: new Date().toISOString(),
    note: 'Manual scan workflow started on Render.',
    progress: { total: queryPlan.length, completed: 0, current: queryPlan[0]?.id || null }
  });

  const findings = [];
  const auditTasks = [];
  const blockers = [];

  for (const task of queryPlan) {
    const taskStarted = new Date().toISOString();
    try {
      setProgress(run, { progress: { total: queryPlan.length, completed: auditTasks.length, current: task.id } });
      const result = await searchWithSerpApi(task);
      const relevant = result.items.filter(candidateLooksRelevant);
      findings.push(...relevant.map((item) => ({
        taskId: task.id,
        geography: task.geography,
        source: task.source,
        title: item.title,
        link: item.link,
        snippet: item.snippet,
        status: 'candidate_unreviewed'
      })));
      if (result.status === 'blocked') blockers.push({ taskId: task.id, reason: result.reason });
      auditTasks.push({
        ...task,
        status: result.status,
        reason: result.reason,
        startedAt: taskStarted,
        finishedAt: new Date().toISOString(),
        resultCount: result.items.length,
        relevantCandidateCount: relevant.length
      });
    } catch (error) {
      const reason = normalizeError(error);
      const failure = { taskId: task.id, reason };
      blockers.push(failure);
      auditTasks.push({
        ...task,
        status: /timeout/i.test(reason) ? 'timeout' : 'failed',
        reason,
        startedAt: taskStarted,
        finishedAt: new Date().toISOString(),
        resultCount: 0,
        relevantCandidateCount: 0
      });
    }
  }

  const status = blockers.length ? (findings.length ? 'partial_completed' : 'blocked') : 'completed';
  const note = summarizeBlockers(blockers, findings);
  console.log(JSON.stringify({ event: 'manual_scan_finished', runId, status, blockerCount: blockers.length, findingCount: findings.length, note }));
  setProgress(run, {
    status,
    outcome: blockers.length ? 'partial' : 'complete',
    finishedAt: new Date().toISOString(),
    note,
    progress: { total: queryPlan.length, completed: queryPlan.length, current: null },
    blockers,
    findings,
    audit: {
      queryCount: queryPlan.length,
      tasks: auditTasks,
      generatedAt: new Date().toISOString(),
      searchConfiguredAtRuntime: Boolean(process.env.SERPAPI_KEY),
      searchTimeoutMs: SEARCH_TIMEOUT_MS,
      admissionPolicy: 'Discovery results are candidates only. Date, active link, duplicate and mandatory third-language filters still require verification before registry update.'
    }
  });
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'hasan-legal-radar-runner', startedAt, searchConfigured: Boolean(process.env.SERPAPI_KEY), searchTimeoutMs: SEARCH_TIMEOUT_MS });
});

app.post('/runs', (req, res) => {
  const runId = `manual-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`;
  const run = {
    runId,
    status: 'accepted',
    outcome: 'partial',
    scope: req.body?.scope || 'full',
    source: req.body?.source || 'manual',
    requestedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    progress: { total: queryPlan.length, completed: 0, current: null },
    blockers: [],
    findings: [],
    audit: null,
    note: 'Manual scan request accepted. Discovery will start asynchronously.'
  };
  runs.set(runId, run);
  setTimeout(() => executeRun(runId).catch((error) => {
    const failed = runs.get(runId);
    if (failed) setProgress(failed, { status: 'failed', outcome: 'partial', finishedAt: new Date().toISOString(), note: error.message });
  }), 0);
  res.status(202).json(publicRun(run));
});

app.get('/runs/:runId', (req, res) => {
  const run = runs.get(req.params.runId);
  if (!run) return res.status(404).json({ error: 'run_not_found' });
  return res.json(publicRun(run));
});

app.get('/runs/:runId/results', (req, res) => {
  const run = runs.get(req.params.runId);
  if (!run) return res.status(404).json({ error: 'run_not_found' });
  return res.json({ runId: run.runId, status: run.status, findings: run.findings, audit: run.audit });
});

app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

const port = Number(process.env.PORT || 10000);
app.listen(port, '0.0.0.0', () => {
  console.log(`Hasan Legal Radar runner listening on ${port}`);
});
