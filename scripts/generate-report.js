#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const REPORT_INPUT = path.resolve(__dirname, '../reports/cucumber_report.json');
const REPORT_OUTPUT = path.resolve(__dirname, '../reports/index.html');
const HISTORY_FILE = path.resolve(__dirname, '../reports/pass-rate-history.json');
const PROJECT_ROOT = path.resolve(__dirname, '..');
const MAX_HISTORY = 30; // keep last 30 runs

function nsToMs(ns) {
  return +(ns / 1_000_000).toFixed(2);
}

function nsToSec(ns) {
  return +(ns / 1_000_000_000).toFixed(3);
}

function statusColor(status) {
  switch (status) {
    case 'passed': return '#22c55e';
    case 'failed': return '#ef4444';
    case 'pending': return '#f59e0b';
    case 'skipped': return '#6b7280';
    default: return '#a855f7';
  }
}

function loadReport(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`Report not found: ${filePath}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadHistory() {
  if (!fs.existsSync(HISTORY_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { return []; }
}

function saveHistory(history) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
}

/**
 * Parse .feature files to extract tags per scenario.
 * Returns a Map keyed by "featureUri|scenarioName" -> string[]
 */
function extractTagsFromFeatureFiles(features) {
  const tagMap = new Map();
  for (const feature of features) {
    const featurePath = path.resolve(PROJECT_ROOT, feature.uri);
    if (!fs.existsSync(featurePath)) continue;
    const lines = fs.readFileSync(featurePath, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (/^Scenario(\s+Outline)?:/i.test(trimmed)) {
        const scenarioName = trimmed.replace(/^Scenario(\s+Outline)?:\s*/i, '').trim();
        const tags = [];
        // Collect consecutive @tag lines immediately above
        for (let j = i - 1; j >= 0; j--) {
          const prev = lines[j].trim();
          if (prev.startsWith('@')) {
            tags.unshift(...(prev.match(/@[\w-]+/g) || []));
          } else {
            break;
          }
        }
        tagMap.set(`${feature.uri}|${scenarioName}`, tags);
      }
    }
  }
  return tagMap;
}

function processData(features, featureTagMap) {
  const scenarios = [];
  const featureSummaries = [];
  let totalPassed = 0, totalFailed = 0, totalPending = 0, totalSkipped = 0;

  for (const feature of features) {
    let fPassed = 0, fFailed = 0, fPending = 0, fSkipped = 0;

    for (const element of feature.elements || []) {
      const steps = (element.steps || []).filter(s => !s.hidden);
      let scenarioDuration = 0;
      let scenarioStatus = 'passed';

      for (const step of steps) {
        const dur = step.result?.duration || 0;
        scenarioDuration += dur;
        const st = step.result?.status || 'undefined';
        if (st === 'failed') scenarioStatus = 'failed';
        else if (st === 'pending' && scenarioStatus !== 'failed') scenarioStatus = 'pending';
        else if (st === 'skipped' && scenarioStatus === 'passed') scenarioStatus = 'skipped';
      }

      // Include hidden hook durations in total benchmark
      const allDuration = (element.steps || []).reduce((sum, s) => sum + (s.result?.duration || 0), 0);

      const tags = (featureTagMap && featureTagMap.get(`${feature.uri}|${element.name}`)) ||
        (element.tags || []).map(t => t.name || t);

      scenarios.push({
        featureName: feature.name,
        name: element.name,
        status: scenarioStatus,
        tags,
        durationMs: nsToMs(allDuration),
        stepDurations: steps.map(s => ({
          name: `${s.keyword}${s.name}`,
          durationMs: nsToMs(s.result?.duration || 0),
          status: s.result?.status || 'undefined',
        })),
        steps,
      });

      if (scenarioStatus === 'passed') { fPassed++; totalPassed++; }
      else if (scenarioStatus === 'failed') { fFailed++; totalFailed++; }
      else if (scenarioStatus === 'pending') { fPending++; totalPending++; }
      else { fSkipped++; totalSkipped++; }
    }

    featureSummaries.push({
      name: feature.name,
      passed: fPassed,
      failed: fFailed,
      pending: fPending,
      skipped: fSkipped,
      total: fPassed + fFailed + fPending + fSkipped,
    });
  }

  const totalScenarios = totalPassed + totalFailed + totalPending + totalSkipped;
  const passRate = totalScenarios > 0 ? ((totalPassed / totalScenarios) * 100).toFixed(1) : '0.0';
  const totalDurationMs = scenarios.reduce((sum, s) => sum + s.durationMs, 0);

  // Build tag summary: tagName -> { passed, failed, pending, skipped }
  const tagSummaryMap = new Map();
  for (const s of scenarios) {
    for (const tag of (s.tags || [])) {
      if (!tagSummaryMap.has(tag)) tagSummaryMap.set(tag, { passed: 0, failed: 0, pending: 0, skipped: 0 });
      const entry = tagSummaryMap.get(tag);
      entry[s.status] = (entry[s.status] || 0) + 1;
    }
  }
  const tagSummary = [...tagSummaryMap.entries()]
    .map(([tag, counts]) => ({ tag, ...counts, total: counts.passed + counts.failed + counts.pending + counts.skipped }))
    .sort((a, b) => b.total - a.total);

  return { scenarios, featureSummaries, tagSummary, totalPassed, totalFailed, totalPending, totalSkipped, totalScenarios, passRate, totalDurationMs };
}

function buildHTML(data, history, generatedAt) {
  const { scenarios, featureSummaries, tagSummary, totalPassed, totalFailed, totalPending, totalSkipped, totalScenarios, passRate, totalDurationMs } = data;

  // Tag chart data
  const tagLabels = JSON.stringify(tagSummary.map(t => t.tag));
  const tagPassed = JSON.stringify(tagSummary.map(t => t.passed));
  const tagFailed = JSON.stringify(tagSummary.map(t => t.failed));
  const tagPending = JSON.stringify(tagSummary.map(t => t.pending));
  const tagSkipped = JSON.stringify(tagSummary.map(t => t.skipped));
  const tagTotals = JSON.stringify(tagSummary.map(t => t.total));

  // Chart data
  const scenarioLabels = JSON.stringify(scenarios.map(s => s.name));
  const scenarioDurations = JSON.stringify(scenarios.map(s => s.durationMs));
  const scenarioColors = JSON.stringify(scenarios.map(s => statusColor(s.status)));

  const featureLabels = JSON.stringify(featureSummaries.map(f => f.name));
  const featurePassed = JSON.stringify(featureSummaries.map(f => f.passed));
  const featureFailed = JSON.stringify(featureSummaries.map(f => f.failed));
  const featurePending = JSON.stringify(featureSummaries.map(f => f.pending));

  const failedScenarios = scenarios.filter(s => s.status === 'failed');
  const failureLabels = JSON.stringify(failedScenarios.map(s => s.name));
  const failureDurations = JSON.stringify(failedScenarios.map(s => s.durationMs));

  // Pass rate history chart data
  const historyLabels = JSON.stringify(history.map(h => h.label));
  const historyPassRates = JSON.stringify(history.map(h => h.passRate));
  const historyPassed = JSON.stringify(history.map(h => h.passed));
  const historyFailed = JSON.stringify(history.map(h => h.failed));
  const historyPending = JSON.stringify(history.map(h => h.pending || 0));
  const historySkipped = JSON.stringify(history.map(h => h.skipped || 0));
  const historyTotal = JSON.stringify(history.map(h => h.total));

  // Step benchmark data (top 15 slowest steps across all scenarios)
  const allSteps = scenarios.flatMap(s =>
    s.stepDurations.map(st => ({ ...st, scenario: s.name }))
  );
  const slowestSteps = [...allSteps].sort((a, b) => b.durationMs - a.durationMs).slice(0, 15);
  const stepLabels = JSON.stringify(slowestSteps.map(s => `${s.name.substring(0, 40)}...`));
  const stepDurations = JSON.stringify(slowestSteps.map(s => s.durationMs));
  const stepColors = JSON.stringify(slowestSteps.map(s => statusColor(s.status)));

  // Results table rows
  const tableRows = scenarios.map(s => {
    const badge = `<span class="badge badge-${s.status}">${s.status.toUpperCase()}</span>`;
    const tagPills = (s.tags || []).map(t => `<span class="tag-pill">${escapeHtml(t)}</span>`).join('');
    const stepList = s.stepDurations.map(st =>
      `<li class="step-item step-${st.status}"><span class="step-name">${escapeHtml(st.name)}</span><span class="step-dur">${st.durationMs} ms</span></li>`
    ).join('');
    return `
      <tr class="scenario-row" data-status="${s.status}">
        <td>${escapeHtml(s.featureName)}</td>
        <td>${escapeHtml(s.name)}</td>
        <td>${tagPills || '<span style="color:#475569">—</span>'}</td>
        <td>${badge}</td>
        <td class="duration-cell">${s.durationMs} ms</td>
        <td>
          <button class="toggle-btn" onclick="toggleSteps(this)">Show steps</button>
          <ul class="step-list hidden">${stepList}</ul>
        </td>
      </tr>`;
  }).join('');

  const overallStatus = totalFailed > 0 ? 'FAILED' : 'PASSED';
  const overallClass = totalFailed > 0 ? 'failed' : 'passed';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Cucumber Test Report</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; }

    /* Header */
    .header { background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%); border-bottom: 1px solid #334155; padding: 24px 32px; display: flex; align-items: center; justify-content: space-between; }
    .header-title { font-size: 1.6rem; font-weight: 700; color: #f8fafc; }
    .header-title span { color: #38bdf8; }
    .header-meta { font-size: 0.8rem; color: #94a3b8; text-align: right; }
    .overall-badge { display: inline-block; padding: 4px 14px; border-radius: 9999px; font-size: 0.85rem; font-weight: 700; letter-spacing: .05em; }
    .overall-badge.passed { background: #14532d; color: #4ade80; }
    .overall-badge.failed { background: #450a0a; color: #f87171; }

    /* Layout */
    .container { max-width: 1400px; margin: 0 auto; padding: 24px 32px; }

    /* Summary cards */
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 32px; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 20px; text-align: center; }
    .card-value { font-size: 2.4rem; font-weight: 800; line-height: 1; }
    .card-label { font-size: 0.75rem; color: #94a3b8; margin-top: 6px; text-transform: uppercase; letter-spacing: .08em; }
    .card.total .card-value { color: #38bdf8; }
    .card.passed .card-value { color: #4ade80; }
    .card.failed .card-value { color: #f87171; }
    .card.pending .card-value { color: #fbbf24; }
    .card.skipped .card-value { color: #9ca3af; }
    .card.rate .card-value { color: #a78bfa; }
    .card.duration .card-value { font-size: 1.6rem; color: #38bdf8; }

    /* Charts grid */
    .charts-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 32px; }
    .charts-grid.full { grid-template-columns: 1fr; }
    @media (max-width: 900px) { .charts-grid { grid-template-columns: 1fr; } }

    .chart-card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 24px; }
    .chart-title { font-size: 1rem; font-weight: 600; color: #f1f5f9; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
    .chart-title::before { content: ''; display: inline-block; width: 4px; height: 18px; border-radius: 2px; background: #38bdf8; }
    .chart-container { position: relative; height: 280px; }
    .chart-container.tall { height: 360px; }
    .no-data { text-align: center; color: #64748b; padding: 60px 0; font-size: 0.9rem; }

    /* Section */
    .section-title { font-size: 1.1rem; font-weight: 700; color: #f1f5f9; margin-bottom: 16px; padding-bottom: 8px; border-bottom: 1px solid #334155; }

    /* Filter bar */
    .filter-bar { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; }
    .filter-btn { padding: 6px 16px; border-radius: 9999px; border: 1px solid #334155; background: #1e293b; color: #94a3b8; cursor: pointer; font-size: 0.8rem; transition: all .15s; }
    .filter-btn:hover, .filter-btn.active { background: #38bdf8; color: #0f172a; border-color: #38bdf8; font-weight: 600; }
    .filter-btn.active-passed { background: #22c55e; color: #fff; border-color: #22c55e; }
    .filter-btn.active-failed { background: #ef4444; color: #fff; border-color: #ef4444; }

    /* Table */
    .table-wrap { overflow-x: auto; border-radius: 12px; border: 1px solid #334155; }
    table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
    thead { background: #1e293b; }
    th { padding: 12px 16px; text-align: left; font-weight: 600; color: #94a3b8; text-transform: uppercase; font-size: 0.75rem; letter-spacing: .06em; border-bottom: 1px solid #334155; }
    td { padding: 12px 16px; border-bottom: 1px solid #1e293b; vertical-align: top; }
    tr:last-child td { border-bottom: none; }
    tr.scenario-row:hover td { background: #1a2744; }
    tr.scenario-row.hidden-row { display: none; }
    tr:nth-child(even) td { background: #182032; }
    tr:nth-child(even):hover td { background: #1a2744; }

    .badge { display: inline-block; padding: 2px 10px; border-radius: 9999px; font-size: 0.72rem; font-weight: 700; letter-spacing: .05em; }
    .badge-passed { background: #14532d; color: #4ade80; }
    .badge-failed { background: #450a0a; color: #f87171; }
    .badge-pending { background: #451a03; color: #fbbf24; }
    .badge-skipped { background: #1e293b; color: #9ca3af; }

    .duration-cell { font-family: 'Courier New', monospace; color: #94a3b8; }

    /* Steps toggle */
    .toggle-btn { background: #334155; color: #94a3b8; border: none; border-radius: 6px; padding: 4px 10px; font-size: 0.75rem; cursor: pointer; transition: background .15s; }
    .toggle-btn:hover { background: #475569; color: #e2e8f0; }
    .step-list { margin-top: 8px; padding-left: 0; list-style: none; }
    .step-list.hidden { display: none; }
    .step-item { display: flex; justify-content: space-between; padding: 4px 8px; border-radius: 4px; margin-bottom: 2px; font-size: 0.78rem; }
    .step-passed { background: #052e16; color: #86efac; }
    .step-failed { background: #2d0c0c; color: #fca5a5; }
    .step-pending { background: #1c1008; color: #fde68a; }
    .step-skipped { background: #1e293b; color: #94a3b8; }
    .step-name { flex: 1; }
    .step-dur { font-family: monospace; margin-left: 12px; white-space: nowrap; }

    /* History chart annotation line */
    .history-note { font-size: 0.75rem; color: #64748b; margin-top: 8px; text-align: right; }

    /* Tag pills in table */
    .tag-pill { display: inline-block; padding: 1px 8px; border-radius: 9999px; font-size: 0.7rem; font-weight: 600; background: #1e3a5f; color: #7dd3fc; border: 1px solid #1d4ed8; margin: 2px 2px 2px 0; white-space: nowrap; }

    /* Footer */
    .footer { text-align: center; padding: 32px; color: #475569; font-size: 0.8rem; border-top: 1px solid #1e293b; margin-top: 32px; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <div class="header-title"><span>Cucumber</span> Test Report</div>
      <div class="header-meta" style="margin-top:6px">Generated: ${generatedAt}</div>
    </div>
    <div style="text-align:right">
      <span class="overall-badge ${overallClass}">${overallStatus}</span>
      <div class="header-meta" style="margin-top:4px">${totalScenarios} scenario(s) · ${(totalDurationMs / 1000).toFixed(2)}s total</div>
    </div>
  </div>

  <div class="container">

    <!-- Summary Cards -->
    <div class="cards">
      <div class="card total"><div class="card-value">${totalScenarios}</div><div class="card-label">Total</div></div>
      <div class="card passed"><div class="card-value">${totalPassed}</div><div class="card-label">Passed</div></div>
      <div class="card failed"><div class="card-value">${totalFailed}</div><div class="card-label">Failed</div></div>
      <div class="card pending"><div class="card-value">${totalPending}</div><div class="card-label">Pending</div></div>
      <div class="card skipped"><div class="card-value">${totalSkipped}</div><div class="card-label">Skipped</div></div>
      <div class="card rate"><div class="card-value">${passRate}%</div><div class="card-label">Pass Rate</div></div>
      <div class="card duration"><div class="card-value">${(totalDurationMs / 1000).toFixed(2)}s</div><div class="card-label">Total Duration</div></div>
    </div>

    <!-- Charts Row 1 -->
    <div class="charts-grid">
      <!-- Test Results Doughnut -->
      <div class="chart-card">
        <div class="chart-title">Test Results Overview</div>
        <div class="chart-container">
          <canvas id="resultsChart"></canvas>
        </div>
      </div>

      <!-- Feature Summary -->
      <div class="chart-card">
        <div class="chart-title">Results by Feature</div>
        <div class="chart-container">
          <canvas id="featureChart"></canvas>
        </div>
      </div>
    </div>

    <!-- Charts Row 2 -->
    <div class="charts-grid">
      <!-- Benchmark: Scenario Duration -->
      <div class="chart-card">
        <div class="chart-title">Benchmarks — Scenario Duration (ms)</div>
        <div class="chart-container">
          <canvas id="benchmarkChart"></canvas>
        </div>
      </div>

      <!-- Test Failures -->
      <div class="chart-card">
        <div class="chart-title">Test Failures</div>
        <div class="chart-container" id="failuresContainer">
          ${failedScenarios.length === 0
            ? '<div class="no-data">No failures detected</div>'
            : '<canvas id="failuresChart"></canvas>'
          }
        </div>
      </div>
    </div>

    <!-- Tags Chart -->
    <div class="charts-grid full" style="margin-bottom:32px">
      <div class="chart-card">
        <div class="chart-title">Scenarios by Tag</div>
        ${tagSummary.length === 0
          ? '<div class="no-data">No tags found in feature files</div>'
          : `<div class="chart-container"><canvas id="tagChart"></canvas></div>`
        }
      </div>
    </div>

    <!-- History Charts Row -->
    <div class="charts-grid" style="margin-bottom:32px">
      <div class="chart-card">
        <div class="chart-title">Pass Rate History</div>
        ${history.length < 2
          ? `<div class="no-data">Run more tests to see the trend (${history.length}/2 run${history.length === 1 ? '' : 's'} recorded)</div>`
          : `<div class="chart-container"><canvas id="historyChart"></canvas></div>
             <div class="history-note">Last ${history.length} run(s) &middot; max ${MAX_HISTORY} stored</div>`
        }
      </div>
      <div class="chart-card">
        <div class="chart-title">Total Test Scenarios History</div>
        ${history.length < 2
          ? `<div class="no-data">Run more tests to see the trend (${history.length}/2 run${history.length === 1 ? '' : 's'} recorded)</div>`
          : `<div class="chart-container"><canvas id="totalScenariosChart"></canvas></div>
             <div class="history-note">Last ${history.length} run(s) &middot; max ${MAX_HISTORY} stored</div>`
        }
      </div>
    </div>

    <!-- Slowest Steps Benchmark -->
    <div class="charts-grid full" style="margin-bottom:32px">
      <div class="chart-card">
        <div class="chart-title">Benchmarks — Slowest Steps (ms)</div>
        <div class="chart-container tall">
          <canvas id="stepChart"></canvas>
        </div>
      </div>
    </div>

    <!-- Detailed Results Table -->
    <div class="section-title">Detailed Results</div>
    <div class="filter-bar">
      <button class="filter-btn active" onclick="filterTable('all', this)">All (${totalScenarios})</button>
      <button class="filter-btn" onclick="filterTable('passed', this)">Passed (${totalPassed})</button>
      <button class="filter-btn" onclick="filterTable('failed', this)">Failed (${totalFailed})</button>
      ${totalPending > 0 ? `<button class="filter-btn" onclick="filterTable('pending', this)">Pending (${totalPending})</button>` : ''}
      ${totalSkipped > 0 ? `<button class="filter-btn" onclick="filterTable('skipped', this)">Skipped (${totalSkipped})</button>` : ''}
    </div>
    <div class="table-wrap">
      <table id="resultsTable">
        <thead>
          <tr>
            <th>Feature</th>
            <th>Scenario</th>
            <th>Tags</th>
            <th>Status</th>
            <th>Duration</th>
            <th>Steps</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>

  </div>

  <div class="footer">Generated by Cucumber HTML Reporter &mdash; ${generatedAt}</div>

<script>
  // Chart.js global defaults
  Chart.defaults.color = '#94a3b8';
  Chart.defaults.borderColor = '#334155';
  Chart.defaults.font.family = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

  // 1. Test Results Doughnut
  new Chart(document.getElementById('resultsChart'), {
    type: 'doughnut',
    data: {
      labels: ['Passed', 'Failed', 'Pending', 'Skipped'],
      datasets: [{
        data: [${totalPassed}, ${totalFailed}, ${totalPending}, ${totalSkipped}],
        backgroundColor: ['#22c55e', '#ef4444', '#f59e0b', '#6b7280'],
        borderColor: '#0f172a',
        borderWidth: 3,
        hoverOffset: 8,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '65%',
      plugins: {
        legend: { position: 'right', labels: { padding: 20, usePointStyle: true } },
        tooltip: { callbacks: { label: ctx => ' ' + ctx.label + ': ' + ctx.parsed + ' (' + ((ctx.parsed / ${totalScenarios}) * 100).toFixed(1) + '%)' } },
      },
    },
  });

  // 2. Feature Summary Bar
  new Chart(document.getElementById('featureChart'), {
    type: 'bar',
    data: {
      labels: ${featureLabels},
      datasets: [
        { label: 'Passed', data: ${featurePassed}, backgroundColor: '#22c55e', borderRadius: 4 },
        { label: 'Failed', data: ${featureFailed}, backgroundColor: '#ef4444', borderRadius: 4 },
        { label: 'Pending', data: ${featurePending}, backgroundColor: '#f59e0b', borderRadius: 4 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { maxRotation: 30 } },
        y: { stacked: true, beginAtZero: true, ticks: { stepSize: 1 } },
      },
      plugins: { legend: { position: 'top' } },
    },
  });

  // 3. Benchmark — Scenario Duration
  new Chart(document.getElementById('benchmarkChart'), {
    type: 'bar',
    data: {
      labels: ${scenarioLabels},
      datasets: [{
        label: 'Duration (ms)',
        data: ${scenarioDurations},
        backgroundColor: ${scenarioColors},
        borderRadius: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: 'y',
      scales: {
        x: { beginAtZero: true, title: { display: true, text: 'ms' } },
        y: { grid: { display: false } },
      },
      plugins: { legend: { display: false } },
    },
  });

  // 4. Test Failures
  ${failedScenarios.length > 0 ? `
  new Chart(document.getElementById('failuresChart'), {
    type: 'bar',
    data: {
      labels: ${failureLabels},
      datasets: [{
        label: 'Duration (ms)',
        data: ${failureDurations},
        backgroundColor: '#ef4444',
        borderColor: '#fca5a5',
        borderWidth: 1,
        borderRadius: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: 'y',
      scales: {
        x: { beginAtZero: true, title: { display: true, text: 'ms' } },
        y: { grid: { display: false } },
      },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { title: ctx => ctx[0].label } },
      },
    },
  });
  ` : ''}

  // 5. Scenarios by Tag
  ${tagSummary.length > 0 ? `
  new Chart(document.getElementById('tagChart'), {
    type: 'bar',
    data: {
      labels: ${tagLabels},
      datasets: [
        { label: 'Passed',  data: ${tagPassed},  backgroundColor: 'rgba(34,197,94,0.85)',  borderColor: '#22c55e', borderWidth: 1, borderRadius: 4, stack: 'tags' },
        { label: 'Failed',  data: ${tagFailed},  backgroundColor: 'rgba(239,68,68,0.85)',  borderColor: '#ef4444', borderWidth: 1, borderRadius: 4, stack: 'tags' },
        { label: 'Pending', data: ${tagPending}, backgroundColor: 'rgba(245,158,11,0.85)', borderColor: '#f59e0b', borderWidth: 1, borderRadius: 4, stack: 'tags' },
        { label: 'Skipped', data: ${tagSkipped}, backgroundColor: 'rgba(107,114,128,0.85)', borderColor: '#6b7280', borderWidth: 1, borderRadius: 4, stack: 'tags' },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { stacked: true, grid: { display: false } },
        y: {
          stacked: true,
          beginAtZero: true,
          title: { display: true, text: 'Scenarios' },
          ticks: { stepSize: 1 },
          grid: { color: 'rgba(51,65,85,0.5)' },
        },
      },
      plugins: {
        legend: { position: 'top', labels: { usePointStyle: true, padding: 16 } },
        tooltip: {
          callbacks: {
            afterBody: (items) => {
              const idx = items[0]?.dataIndex;
              const total = ${tagTotals}[idx];
              return ['', ' Total: ' + total];
            },
          },
        },
      },
    },
  });
  ` : ''}

  // 6. Pass Rate History
  ${history.length >= 2 ? `
  new Chart(document.getElementById('historyChart'), {
    type: 'line',
    data: {
      labels: ${historyLabels},
      datasets: [
        {
          label: 'Pass Rate (%)',
          data: ${historyPassRates},
          borderColor: '#a78bfa',
          backgroundColor: 'rgba(167,139,250,0.12)',
          pointBackgroundColor: ${historyPassRates}.map(v => v === 100 ? '#22c55e' : v >= 80 ? '#f59e0b' : '#ef4444'),
          pointRadius: 5,
          pointHoverRadius: 7,
          borderWidth: 2,
          tension: 0.35,
          fill: true,
          yAxisID: 'yRate',
        },
        {
          label: 'Passed',
          data: ${historyPassed},
          borderColor: '#22c55e',
          backgroundColor: 'transparent',
          pointRadius: 3,
          borderWidth: 1.5,
          borderDash: [4, 3],
          tension: 0.35,
          yAxisID: 'yCount',
        },
        {
          label: 'Failed',
          data: ${historyFailed},
          borderColor: '#ef4444',
          backgroundColor: 'transparent',
          pointRadius: 3,
          borderWidth: 1.5,
          borderDash: [4, 3],
          tension: 0.35,
          yAxisID: 'yCount',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { grid: { color: 'rgba(51,65,85,0.5)' }, ticks: { maxRotation: 40, font: { size: 11 } } },
        yRate: {
          position: 'left',
          min: 0, max: 100,
          title: { display: true, text: 'Pass Rate (%)' },
          ticks: { callback: v => v + '%' },
          grid: { color: 'rgba(51,65,85,0.5)' },
        },
        yCount: {
          position: 'right',
          beginAtZero: true,
          title: { display: true, text: 'Count' },
          ticks: { stepSize: 1 },
          grid: { display: false },
        },
      },
      plugins: {
        legend: { position: 'top', labels: { usePointStyle: true, padding: 16 } },
        tooltip: {
          callbacks: {
            label: ctx => {
              if (ctx.dataset.yAxisID === 'yRate') return ' Pass Rate: ' + ctx.parsed.y + '%';
              return ' ' + ctx.dataset.label + ': ' + ctx.parsed.y;
            },
            afterBody: (items) => {
              const idx = items[0]?.dataIndex;
              const total = ${historyTotal}[idx];
              return total != null ? ['', ' Total scenarios: ' + total] : [];
            },
          },
        },
      },
    },
  });
  ` : ''}

  // 7. Total Test Scenarios History
  ${history.length >= 2 ? `
  new Chart(document.getElementById('totalScenariosChart'), {
    type: 'bar',
    data: {
      labels: ${historyLabels},
      datasets: [
        {
          label: 'Passed',
          data: ${historyPassed},
          backgroundColor: 'rgba(34,197,94,0.85)',
          borderColor: '#22c55e',
          borderWidth: 1,
          borderRadius: 3,
          stack: 'scenarios',
        },
        {
          label: 'Failed',
          data: ${historyFailed},
          backgroundColor: 'rgba(239,68,68,0.85)',
          borderColor: '#ef4444',
          borderWidth: 1,
          borderRadius: 3,
          stack: 'scenarios',
        },
        {
          label: 'Pending',
          data: ${historyPending},
          backgroundColor: 'rgba(245,158,11,0.85)',
          borderColor: '#f59e0b',
          borderWidth: 1,
          borderRadius: 3,
          stack: 'scenarios',
        },
        {
          label: 'Skipped',
          data: ${historySkipped},
          backgroundColor: 'rgba(107,114,128,0.85)',
          borderColor: '#6b7280',
          borderWidth: 1,
          borderRadius: 3,
          stack: 'scenarios',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { maxRotation: 40, font: { size: 11 } } },
        y: {
          stacked: true,
          beginAtZero: true,
          title: { display: true, text: 'Scenarios' },
          ticks: { stepSize: 1 },
          grid: { color: 'rgba(51,65,85,0.5)' },
        },
      },
      plugins: {
        legend: { position: 'top', labels: { usePointStyle: true, padding: 16 } },
        tooltip: {
          callbacks: {
            afterBody: (items) => {
              const idx = items[0]?.dataIndex;
              const total = ${historyTotal}[idx];
              const rate = ${historyPassRates}[idx];
              return total != null ? ['', ' Total: ' + total + '  |  Pass Rate: ' + rate + '%'] : [];
            },
          },
        },
      },
    },
  });
  ` : ''}

  // 8. Slowest Steps
  new Chart(document.getElementById('stepChart'), {
    type: 'bar',
    data: {
      labels: ${stepLabels},
      datasets: [{
        label: 'Duration (ms)',
        data: ${stepDurations},
        backgroundColor: ${stepColors},
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: 'y',
      scales: {
        x: { beginAtZero: true, title: { display: true, text: 'ms' } },
        y: { grid: { display: false }, ticks: { font: { size: 11 } } },
      },
      plugins: { legend: { display: false } },
    },
  });

  // Filter table
  function filterTable(status, btn) {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active', 'active-passed', 'active-failed'));
    btn.classList.add('active');
    if (status !== 'all') btn.classList.add('active-' + status);
    document.querySelectorAll('.scenario-row').forEach(row => {
      row.classList.toggle('hidden-row', status !== 'all' && row.dataset.status !== status);
    });
  }

  // Toggle step list
  function toggleSteps(btn) {
    const list = btn.nextElementSibling;
    const hidden = list.classList.toggle('hidden');
    btn.textContent = hidden ? 'Show steps' : 'Hide steps';
  }
</script>
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// --- Main ---
console.log('Reading:', REPORT_INPUT);
const features = loadReport(REPORT_INPUT);
const featureTagMap = extractTagsFromFeatureFiles(features);
const data = processData(features, featureTagMap);
console.log(`Tags found: ${[...featureTagMap.values()].flat().filter((v,i,a) => a.indexOf(v) === i).join(', ') || '(none)'}`);
const now = new Date();
const generatedAt = now.toLocaleString();

// Append current run to history
const history = loadHistory();
history.push({
  timestamp: now.toISOString(),
  label: now.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
  passRate: parseFloat(data.passRate),
  passed: data.totalPassed,
  failed: data.totalFailed,
  pending: data.totalPending,
  skipped: data.totalSkipped,
  total: data.totalScenarios,
  durationMs: Math.round(data.totalDurationMs),
});
if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
saveHistory(history);
console.log(`History updated: ${history.length} run(s) stored in ${HISTORY_FILE}`);

const html = buildHTML(data, history, generatedAt);

fs.mkdirSync(path.dirname(REPORT_OUTPUT), { recursive: true });
fs.writeFileSync(REPORT_OUTPUT, html, 'utf8');

console.log('Report generated:', REPORT_OUTPUT);
console.log(`  Total: ${data.totalScenarios} | Passed: ${data.totalPassed} | Failed: ${data.totalFailed} | Pass Rate: ${data.passRate}%`);
