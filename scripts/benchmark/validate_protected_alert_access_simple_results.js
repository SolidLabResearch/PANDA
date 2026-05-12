#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
function latest() {
  const root = path.join(ROOT, 'benchmark-results');
  const dirs = fs.readdirSync(root).filter((d) => d.startsWith('protected-alert-access-simple-')).map((d) => ({ d, m: fs.statSync(path.join(root, d)).mtimeMs })).sort((a,b)=>b.m-a.m);
  if (!dirs.length) throw new Error('No protected-alert-access-simple results found');
  const dir = path.join(root, dirs[0].d);
  return path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith('.summary.json')));
}
const arg = process.argv.slice(2);
const p = (arg[arg.indexOf('--summary') + 1]) || latest();
const s = JSON.parse(fs.readFileSync(p, 'utf8'));
const failures = [];
if (s.status !== 'ok') failures.push('status must be ok');
if (s.unauthenticated_alert_get_status === 200) failures.push('resource not protected');
if (!(s.alert_challenge_status === 401 || s.alert_challenge_status === 403)) failures.push('challenge status must be 401 or 403');
if (s.alert_token_exchange_status !== 200) failures.push('token exchange must be 200');
if (s.authorized_alert_get_status !== 200) failures.push('authorized get must be 200');
if (s.authorized_response_contains_expected_benchmark_run_id !== true) failures.push('authorized response mismatch');
console.log(JSON.stringify({ benchmark_name: 'protected-alert-access-simple', summary_path: p, passed: failures.length === 0, failures }, null, 2));
process.exit(failures.length ? 1 : 0);
