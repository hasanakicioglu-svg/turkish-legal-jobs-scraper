import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {checkCoverage, checkReceipt, REQUIRED_CHECKS} from './gates.mjs';

export function command(argv, {cwd, env, signal, timeoutMs=1800000} = {}) {
  if (!Array.isArray(argv) || !argv.length || argv.some(x=>typeof x!=='string')) throw Error('Expected command argument array');
  return new Promise((resolve, reject) => {
    // No shell and no user-supplied executable/arguments. Provider output is kept out of API responses.
    const child = spawn(argv[0], argv.slice(1), {cwd, env:{...process.env,...env}, stdio:'ignore', detached:process.platform!=='win32'});
    let killTimer; let timedOut = false;
    const kill = sig => {try {process.platform==='win32' ? child.kill(sig) : process.kill(-child.pid,sig);} catch {}};
    const abort = () => {kill('SIGTERM'); killTimer = setTimeout(()=>kill('SIGKILL'),2000);};
    const timer = setTimeout(()=>{timedOut=true;abort();},timeoutMs);
    signal?.addEventListener('abort',abort,{once:true});
    if (signal?.aborted) abort();
    const cleanup = () => {clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',abort);};
    child.on('error',()=>{cleanup();reject(Error('COMMAND_START_FAILED'));});
    child.on('close',code=>{cleanup();
      if(signal?.aborted) reject(Error('INTERRUPTED'));
      else if(timedOut) reject(Error('COMMAND_TIMEOUT'));
      else if(code!==0) reject(Error('COMMAND_FAILED'));
      else resolve();
    });
  });
}

export async function processNext(queue, config, {signal, execute=command}={}) {
  const run = queue.claim(); if (!run) return false;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort',abort,{once:true});
  if (signal?.aborted) abort();
  const beat = setInterval(()=>{if(!queue.heartbeat(run.id,run.owner))controller.abort();}, Math.max(10,Math.floor(queue.leaseMs/3)));
  const context = {cwd:config.repoDir, signal:controller.signal, env:{
    RADAR_LEDGER_ID:run.payload.ledgerId, RADAR_LANE:run.lane, RADAR_DAY:run.day,
    RADAR_ATTEMPT:String(run.attempts), RADAR_RESUME:'true'
  }};
  try {
    for(const file of ['SCAN_PROTOCOL.md','dist/scan-plan.json','dist/completed-workflow.json','dist/registry.json']) {
      if(!fs.existsSync(path.join(config.repoDir,file))) throw Error('REPOSITORY_INPUT_MISSING');
    }
    // Adapter resumes this ledger and checkpoints individual operations. It must never initialize a replacement run.
    await execute(config.scanCommand,context);
    const coverage=checkCoverage(config.repoDir,run.payload.ledgerId,run.lane);
    await execute([process.execPath,path.join(import.meta.dirname,'validate-run.mjs')],context);
    for(const check of REQUIRED_CHECKS) await execute([process.execPath,check],context);
    await execute([process.execPath,'--check','dist/quality.js'],context);
    await execute(['git','diff','--check'],context);
    // Publisher must reconcile an existing deployment before retrying, and write a server-confirmed receipt.
    await execute(config.publishCommand,{...context,env:{...context.env,RADAR_LEDGER_HASH:coverage.ledgerHash}});
    const result=checkReceipt(config.repoDir,`runs/publications/${run.payload.ledgerId}.json`,{
      ledgerId:run.payload.ledgerId,lane:run.lane,ledgerHash:coverage.ledgerHash});
    queue.finish(run.id,run.owner,result);
  } catch(e) {
    const transient=['COMMAND_TIMEOUT','COMMAND_FAILED','INTERRUPTED','LEDGER_INCOMPLETE'].includes(e.message);
    // Do not leak provider messages, credentials or command arguments through /runs.
    try {queue.fail(run.id,run.owner,transient?e.message:'VERIFICATION_OR_CONFIGURATION_BLOCKED',{retryable:transient});} catch {}
  } finally {clearInterval(beat);signal?.removeEventListener('abort',abort);}
  return true;
}
