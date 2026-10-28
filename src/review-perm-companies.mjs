#!/usr/bin/env node
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { validateRun } from './run-contract.mjs';
import { loadScanResults } from './scan-results.mjs';
import { reviewPermCompanies } from './perm-history.mjs';

try {
  const args = process.argv.slice(2), command = args[0], at = args.indexOf('--run');
  if (!['prepare', 'freeze'].includes(command) || at < 0 || !args[at + 1]) throw new Error('Usage: review-perm-companies.mjs prepare|freeze --run DIR [--decisions FILE]');
  const root = path.resolve(args[at + 1]);
  if (existsSync(path.join(root, 'receipt.json')) || existsSync(path.join(root, 'perm-history.json'))) throw new Error('Company research is only for new reports before persistence');
  const run = validateRun(root), results = loadScanResults(root), decisionAt = args.indexOf('--decisions');
  if (command === 'freeze' && (decisionAt < 0 || !args[decisionAt + 1])) throw new Error('freeze requires --decisions FILE');
  const decisions = command === 'freeze' ? JSON.parse(readFileSync(args[decisionAt + 1], 'utf8')) : undefined;
  if (decisions && !Array.isArray(decisions.companies)) throw new Error('decisions needs a companies array');
  const result = reviewPermCompanies(root, run, results, decisions);
  if (command === 'prepare') {
    const file = path.join(root, 'perm-company-review-request.json'), text = JSON.stringify(result, null, 2) + '\n';
    if (existsSync(file)) {
      if (lstatSync(file).isSymbolicLink() || readFileSync(file, 'utf8') !== text) throw new Error('Company research request changed; do not overwrite');
    } else writeFileSync(file, text, { flag: 'wx', mode: 0o600 });
  }
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error.message); process.exitCode = 1;
}
