import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const REQUIRED_CHECKS = ['scripts/validate.mjs','scripts/test.mjs',
  'scripts/test-review-queue.mjs','scripts/test-search-quality.mjs'];
export const sha256 = data => createHash('sha256').update(data).digest('hex');
export function readInside(root, relative) {
  const resolvedRoot = fs.realpathSync(root);
  const file = fs.realpathSync(path.resolve(root, relative));
  if (!file.startsWith(resolvedRoot + path.sep)) throw Error('Evidence path outside repository');
  return fs.readFileSync(file);
}
export function checkCoverage(root, ledgerId, lane) {
  const raw = readInside(root, `runs/${ledgerId}.json`);
  const ledger = JSON.parse(raw);
  if (ledger.runId !== ledgerId) throw Error('Wrong ledger');
  if (ledger.outcome !== 'complete') throw Error('LEDGER_INCOMPLETE');
  if (lane === 'ai' && ledger.line !== 'ai') throw Error('Wrong ledger line');
  if (lane !== 'ai' && ledger.line !== 'leadership') throw Error('Wrong ledger line');
  if (!Array.isArray(ledger.tasks) || !ledger.tasks.length || ledger.tasks.some(t => t.status !== 'reviewed')) throw Error('Source tasks incomplete');
  // The repository's existing evidence validator remains authoritative; do not replace it with counts.
  for (const task of ledger.tasks) {
    const attempt = task.attempts?.at(-1);
    if (!attempt?.evidencePath) throw Error('Missing task evidence');
    readInside(root, attempt.evidencePath);
  }
  return {ledger, ledgerHash: sha256(raw)};
}
export function checkReceipt(root, receiptPath, {ledgerId, lane, ledgerHash}) {
  const receipt = JSON.parse(readInside(root, receiptPath));
  if (receipt.ledgerId !== ledgerId || receipt.lane !== lane || receipt.ledgerHash !== ledgerHash) throw Error('Publication receipt does not match ledger');
  if (receipt.status !== 'published' || !/^[a-f0-9]{40}$/.test(receipt.commitSha || '') || !receipt.deploymentId) throw Error('Missing publication confirmation');
  if (receipt.projectId !== 'appgprj_6aa6887b4f608191b6ff5e91a1d6a03c') throw Error('Wrong dashboard');
  const evidence = JSON.parse(readInside(root, receipt.deploymentEvidencePath));
  if (evidence.projectId !== receipt.projectId || evidence.deploymentId !== receipt.deploymentId ||
      evidence.commitSha !== receipt.commitSha || evidence.status !== 'live') throw Error('Deployment not confirmed live');
  return {deploymentId: receipt.deploymentId, commitSha: receipt.commitSha, ledgerHash};
}
