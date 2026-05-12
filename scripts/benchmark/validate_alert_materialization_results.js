#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
function latest() {
  const root = path.join(ROOT, 'benchmark-results');
  const dirs = fs.readdirSync(root).filter((d) => d.startsWith('alert-materialization-')).map((d) => ({ d, m: fs.statSync(path.join(root, d)).mtimeMs })).sort((a,b)=>b.m-a.m);
  if (!dirs.length) throw new Error('No alert-materialization results found');
  const dir = path.join(root, dirs[0].d);
  return path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith('.summary.json')));
}
const arg = process.argv.slice(2);
const p = (arg[arg.indexOf('--summary') + 1]) || latest();
const s = JSON.parse(fs.readFileSync(p, 'utf8'));
const failures = [];
if (s.status !== 'ok') failures.push('status must be ok');
if (!s.benchmark_run_id) failures.push('benchmark_run_id missing');
if (s.alert_materialized !== true) failures.push('alert_materialized must be true');
if (!s.alert_path) failures.push('alert_path missing');
if (s.alert_contains_current_benchmark_run_id !== true) failures.push('alert run id proof missing');
console.log(JSON.stringify({ benchmark_name: 'alert-materialization', summary_path: p, passed: failures.length === 0, failures }, null, 2));
process.exit(failures.length ? 1 : 0);
