import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {Queue} from './queue.mjs';
import {checkReceipt,sha256} from './gates.mjs';
import {processNext,command} from './worker.mjs';
import {configuration} from './server.mjs';
const temps=[];
const temp=()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'radar-recovery-'));temps.push(dir);return dir;};
process.on('exit',()=>temps.forEach(d=>fs.rmSync(d,{recursive:true,force:true})));
const input=lane=>({day:'2026-10-26',lane,ledgerId:`${lane}-20261026`});
test('same day/lane resumes original identity and conflicting ledger is rejected',()=>{
  const q=new Queue(path.join(temp(),'db')); const a=q.enqueue(input('kariyer'));
  assert.equal(q.enqueue(input('kariyer')).id,a.id);
  assert.throws(()=>q.enqueue({...input('kariyer'),ledgerId:'replacement'}));q.close();
});
test('batch insertion is atomic when one lane conflicts',()=>{
  const q=new Queue(path.join(temp(),'db'));q.enqueue(input('ai'));
  assert.throws(()=>q.enqueueBatch([input('kariyer'),{...input('ai'),ledgerId:'wrong'}]));
  assert.equal(q.db.prepare('SELECT count(*) n FROM runs').get().n,1);q.close();
});
test('two connections cannot claim simultaneous work; retry blocks following lane',()=>{
  const file=path.join(temp(),'db');let now=1000;
  const a=new Queue(file,{now:()=>now}),b=new Queue(file,{now:()=>now});
  a.enqueueBatch([input('ai'),input('linkedin'),input('kariyer')]);
  const r=a.claim();assert.equal(r.lane,'kariyer');assert.equal(b.claim(),null);
  a.fail(r.id,r.owner,'TIMEOUT');assert.equal(b.claim(),null);
  now+=30001;assert.equal(b.claim().id,r.id);a.close();b.close();
});
test('actual killed process leaves durable claim that is resumed after lease expiration',()=>{
  const file=path.join(temp(),'db');const module=pathToFileURL(path.resolve(import.meta.dirname,'queue.mjs')).href;
  const script=`import {Queue} from ${JSON.stringify(module)};
    const q=new Queue(${JSON.stringify(file)},{now:()=>1000,leaseMs:100});
    q.enqueue(${JSON.stringify(input('kariyer'))});q.claim();process.kill(process.pid,'SIGKILL');`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',script]);
  assert.equal(child.signal,'SIGKILL');
  const q=new Queue(file,{now:()=>1101,leaseMs:100});const r=q.claim();
  assert.equal(r.payload.ledgerId,'kariyer-20261026');assert.equal(r.attempts,2);q.close();
});
test('expired worker cannot finish a reclaimed run',()=>{
  let now=1000;const q=new Queue(path.join(temp(),'db'),{now:()=>now,leaseMs:100});
  q.enqueue(input('kariyer'));const old=q.claim();now=1101;const fresh=q.claim();
  assert.throws(()=>q.finish(old.id,old.owner,{}));q.finish(fresh.id,fresh.owner,{});q.close();
});
test('bounded retries require explicit operator action, preserving ledger ID',()=>{
  const q=new Queue(path.join(temp(),'db'),{maxAttempts:1});q.enqueue(input('kariyer'));const r=q.claim();
  q.fail(r.id,r.owner,'TIMEOUT');assert.equal(q.get(r.id).status,'needs_attention');assert.equal(q.claim(),null);
  q.retry(r.id);assert.equal(q.claim().payload.ledgerId,r.payload.ledgerId);q.close();
});
function fixture(){
  const root=temp();for(const d of ['dist','runs/publications','scripts'])fs.mkdirSync(path.join(root,d),{recursive:true});
  for(const f of ['SCAN_PROTOCOL.md','dist/scan-plan.json','dist/completed-workflow.json','dist/registry.json'])fs.writeFileSync(path.join(root,f),'{}');
  const ledger={runId:'kariyer-20261026',line:'leadership',outcome:'complete',tasks:[{status:'reviewed',attempts:[{evidencePath:'runs/evidence.json'}]}]};
  fs.writeFileSync(path.join(root,'runs/evidence.json'),'{}');
  fs.writeFileSync(path.join(root,'runs/kariyer-20261026.json'),JSON.stringify(ledger));
  const q=new Queue(path.join(root,'queue.sqlite'));const run=q.enqueue(input('kariyer'));
  return {root,q,run,config:{repoDir:root,scanCommand:['scan'],publishCommand:['publish']}};
}
test('successful command exit alone never completes or publishes an incomplete run',async()=>{
  const f=fixture();const p=path.join(f.root,'runs/kariyer-20261026.json');
  const ledger=JSON.parse(fs.readFileSync(p));ledger.outcome='partial';fs.writeFileSync(p,JSON.stringify(ledger));
  const calls=[];await processNext(f.q,f.config,{execute:async argv=>calls.push(argv)});
  assert.equal(f.q.get(f.run.id).status,'retry_wait');assert.equal(calls.length,1);f.q.close();
});
test('failing validation blocks publication',async()=>{
  const f=fixture();const calls=[];
  await processNext(f.q,f.config,{execute:async argv=>{calls.push(argv);if(argv.includes('scripts/validate.mjs'))throw Error('COMMAND_FAILED');}});
  assert(!calls.some(x=>x[0]==='publish'));assert.notEqual(f.q.get(f.run.id).status,'completed');f.q.close();
});
test('successful publication command without receipt is not completion',async()=>{
  const f=fixture();await processNext(f.q,f.config,{execute:async()=>{}});
  assert.equal(f.q.get(f.run.id).status,'needs_attention');f.q.close();
});
test('complete requires all gates and matching live publication evidence',async()=>{
  const f=fixture();const calls=[];
  await processNext(f.q,f.config,{execute:async(argv,ctx)=>{
    calls.push(argv);
    if(argv[0]==='publish'){
      const receipt={ledgerId:'kariyer-20261026',lane:'kariyer',ledgerHash:ctx.env.RADAR_LEDGER_HASH,
        status:'published',commitSha:'a'.repeat(40),deploymentId:'test-deployment',
        projectId:'appgprj_6aa6887b4f608191b6ff5e91a1d6a03c',deploymentEvidencePath:'runs/deploy.json'};
      fs.writeFileSync(path.join(f.root,'runs/publications/kariyer-20261026.json'),JSON.stringify(receipt));
      fs.writeFileSync(path.join(f.root,'runs/deploy.json'),JSON.stringify({...receipt,status:'live'}));
    }
  }});
  assert.equal(f.q.get(f.run.id).status,'completed');assert(calls.some(x=>x.includes('scripts/test-search-quality.mjs')));f.q.close();
});
test('stale deployment receipt and path escape are rejected',()=>{
  const f=fixture();fs.writeFileSync(path.join(f.root,'runs/bad.json'),JSON.stringify({ledgerId:'other'}));
  assert.throws(()=>checkReceipt(f.root,'runs/bad.json',{ledgerId:'kariyer-20261026'}));
  assert.throws(()=>checkReceipt(f.root,'../outside.json',{}));f.q.close();
});
test('free or ephemeral storage and absent adapters cannot advertise ready',()=>{
  const f=fixture();const c=configuration({RADAR_REPO_DIR:f.root,RADAR_STORE_DIR:f.root,RADAR_RUNNER_TOKEN:'x'.repeat(40)});
  assert.equal(c.ready,false);assert(c.blockers.includes('persistent_disk_missing'));
  assert(c.blockers.includes('full_scan_adapter_missing'));f.q.close();
});
test('command timeout stops child and returns retryable error',async()=>{
  await assert.rejects(command([process.execPath,'-e','setInterval(()=>{},1000)'],{timeoutMs:100}),/COMMAND_TIMEOUT/);
});
