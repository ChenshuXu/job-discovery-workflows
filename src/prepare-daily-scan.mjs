#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupExpiredEvaluated } from './evaluated-retention.mjs';
import { captureBaseline } from './verify-scan-receipt.mjs';
import { observeScanUsage, startScanUsage } from './scan-usage.mjs';

export async function prepareDailyScan({ runRoot, careerRoot, asOfDate = null, cleanup = cleanupExpiredEvaluated, capture = captureBaseline, startUsage = startScanUsage }) {
  observeScanUsage(() => startUsage({ runRoot }));
  const retention = await cleanup({ runRoot, careerRoot, ...(asOfDate ? { asOfDate } : {}) });
  const maintenance = {
    evaluated_retention: {
      audit_path: path.relative(path.resolve(runRoot), retention.auditFile),
      as_of_date: retention.audit.as_of_date,
      ttl_days: retention.audit.ttl_days,
      cutoff_date: retention.audit.cutoff_date,
      cleaned_count: retention.audit.cleaned_count,
      protected_count: retention.audit.protected_count,
    },
  };
  return capture({ runRoot, careerRoot, maintenance });
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  try {
    const runRoot = arg('--run');
    const careerRoot = arg('--career-ops');
    if (!runRoot || !careerRoot) throw new Error('Usage: node src/prepare-daily-scan.mjs --run runs/<run-id> --career-ops ../career-ops');
    console.log(JSON.stringify(await prepareDailyScan({ runRoot, careerRoot }), null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
