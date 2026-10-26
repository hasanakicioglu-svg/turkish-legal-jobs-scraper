import {createServer} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {Queue} from './queue.mjs';
import {processNext} from './worker.mjs';

const parseCommand = value => {try {const a=JSON.parse(value);return Array.isArray(a)&&a.length&&a.every(x=>typeof x==='string')?a:null;}catch{return null;}};
export function configuration(env=process.env) {
  const config={repoDir:env.RADAR_REPO_DIR,storeDir:env.RADAR_STORE_DIR,
    token:env.RADAR_RUNNER_TOKEN,scanCommand:parseCommand(env.RADAR_SCAN_COMMAND_JSON),
    publishCommand:parseCommand(env.RADAR_PUBLISH_COMMAND_JSON)};
  const blockers=[];
  if(!config.token || config.token.length<32) blockers.push('owner_authentication_missing');
  if(!config.scanCommand) blockers.push('full_scan_adapter_missing');
  if(!config.publishCommand) blockers.push('publication_adapter_missing');
  const mount=env.RENDER_DISK_MOUNT_PATH;
  let durable=false;
  try {
    const actualMount=fs.realpathSync(mount), actualStore=fs.realpathSync(config.storeDir);
    const actualRepo=fs.realpathSync(config.repoDir);
    durable=actualMount!==path.parse(actualMount).root &&
      (actualStore===actualMount || actualStore.startsWith(actualMount+path.sep)) &&
      (actualRepo===actualMount || actualRepo.startsWith(actualMount+path.sep));
  } catch {}
  if(!durable) blockers.push('persistent_disk_missing');
  for(const file of ['SCAN_PROTOCOL.md','dist/scan-plan.json','dist/completed-workflow.json','dist/registry.json']) {
    if(!config.repoDir || !fs.existsSync(path.join(config.repoDir,file))) blockers.push(`missing_${file}`);
  }
  return {...config,blockers,ready:blockers.length===0};
}
function authorized(req,token) {
  if(!token) return false;
  const a=Buffer.from(req.headers.authorization||''),b=Buffer.from(`Bearer ${token}`);
  return a.length===b.length && timingSafeEqual(a,b);
}
export function handler(config,queue) {
  return async(req,res)=>{
    const send=(code,body)=>{res.writeHead(code,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));};
    if(req.method==='GET' && req.url==='/health') return send(200,{ok:true,ready:config.ready,
      engineContract:'source-balanced-same-engine-v1',blockers:config.blockers});
    if(!authorized(req,config.token)) return send(401,{error:'unauthorized'});
    if(!config.ready) return send(503,{status:'blocked',blockers:config.blockers});
    try {
      if(req.method==='POST' && req.url==='/runs') {
        let body=''; for await(const chunk of req) {body+=chunk;if(Buffer.byteLength(body)>8192)return send(413,{error:'body_too_large'});}
        const input=JSON.parse(body);
        const entries=Array.isArray(input.runs)?input.runs:[input];
        if(entries.length>4) return send(400,{error:'at_most_four_lanes'});
        // Validate the entire request before enqueuing any part.
        for(const r of entries) {
          if(!['kariyer','linkedin','legal-sources','ai'].includes(r.lane)||!/^\d{4}-\d{2}-\d{2}$/.test(r.day)||
            !/^[a-zA-Z0-9_-]{1,120}$/.test(r.ledgerId||'')) return send(400,{error:'invalid_run'});
        }
        return send(202,{runs:queue.enqueueBatch(entries).map(publicRun)});
      }
      const match=req.url?.match(/^\/runs\/([a-f0-9]{24})(\/retry)?$/);
      if(match && req.method==='POST' && match[2]) return send(202,publicRun(queue.retry(match[1])));
      if(match && req.method==='GET' && !match[2]) {
        const run=queue.get(match[1]); return run?send(200,publicRun(run)):send(404,{error:'not_found'});
      }
      return send(404,{error:'not_found'});
    }catch{return send(400,{error:'invalid_request_or_conflicting_ledger'});}
  };
}
function publicRun(run) {
  const {owner,lease_until,payload,...safe}=run;
  return {...safe,ledgerId:payload.ledgerId};
}

if(import.meta.url===new URL(process.argv[1], 'file:').href) {
  const config=configuration();
  const queue=config.ready?new Queue(path.join(config.storeDir,'queue.sqlite')):null;
  const controller=new AbortController(); let busy=false;
  const tick=async()=>{if(busy||!config.ready||controller.signal.aborted)return;busy=true;
    try{await processNext(queue,config,{signal:controller.signal});}
    catch{console.error('Runner queue unavailable');}finally{busy=false;}};
  const timer=setInterval(tick,2000);
  const server=createServer(handler(config,queue));
  server.listen(Number(process.env.PORT||10000),'0.0.0.0');
  const shutdown=()=>{clearInterval(timer);controller.abort();server.close();
    const wait=setInterval(()=>{if(!busy){clearInterval(wait);queue?.close();process.exit(0);}},50);};
  process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
}
