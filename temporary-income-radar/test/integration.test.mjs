import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import net from 'node:net';
const token='local-test-secret';
const srv=net.createServer();await new Promise(r=>srv.listen(0,'127.0.0.1',r));const port=srv.address().port;await new Promise(r=>srv.close(r));
const child=spawn(process.execPath,['--import','./test/mock-fetch.mjs','./app.js'],{cwd:new URL('../',import.meta.url),env:{...process.env,PORT:String(port),RADAR_RUN_TOKEN:token},stdio:'ignore'});
after(()=>child.kill('SIGTERM'));
const root=`http://127.0.0.1:${port}`;
for(let i=0;i<70;i++){try{const r=await fetch(root+'/health');if(r.ok)break}catch{}await new Promise(r=>setTimeout(r,40));}
const request=async(path,body,auth=true)=>{
 const opts=body?{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)}:{};
 const r=await fetch(root+path,opts);return {status:r.status,data:await r.json()};
};
test('catalogue lists independently selectable groups and sources',async()=>{
 const {data,status}=await request('/v2/catalog');assert.equal(status,200);assert.equal(data.groups.length,6);assert.equal(data.sources.filter(s=>s.mode==='api').length,5);assert(data.sources.some(s=>s.id==='terac'&&s.mode==='manual'));assert.equal(new Set(data.sources.map(s=>s.id)).size,data.sources.length);
});
test('manual-source checks cannot be misreported as successful API scans',async()=>{
 const {data}=await request('/v2/scan',{sourceId:'terac'});assert.equal(data.checks.length,1);assert.equal(data.checks[0].source,'Terac');assert.equal(data.checks[0].status,'not-integrated');assert.equal(data.checks[0].found,0);
});
test('manual-only group returns ordered, separate audits',async()=>{
 const {data}=await request('/v2/scan',{groupId:'microtasks'});assert.deepEqual(data.checks.map(x=>x.source),['Prolific','Terac','Clickworker','Toloka']);assert(data.checks.every(x=>x.status==='not-integrated'));
});
test('authentication blocks unauthorised mutations',async()=>{
 const {status}=await request('/v2/scan',{sourceId:'mercor'},false);assert.equal(status,401);
});
test('invalid source IDs fail without searching everything',async()=>{
 const {status}=await request('/v2/scan',{sourceId:'does-not-exist'});assert.equal(status,400);
});
test('all connected APIs run in source order and build deduplicated results',async()=>{
 const {data,status}=await request('/v2/scan',{allConnected:true});assert.equal(status,200);assert.deepEqual(data.checks.map(x=>x.source),['Remotive','Himalayas','Remote OK','Jobicy','Arbeitnow']);assert(data.checks.every(x=>x.status==='ok'));assert(data.snapshot.jobs.length>=4);assert(data.snapshot.jobs.some(x=>x.eligibility==='eligible'));
});
test('a repeated source scan returns cached status',async()=>{
 const {data}=await request('/v2/scan',{sourceId:'remotive'});assert.equal(data.checks[0].status,'cached');
});
test('legacy parallel-run endpoint is disabled',async()=>{
 const {status}=await request('/v1/scan',{all:true});assert.equal(status,410);
});
test('health and progress endpoints work without revealing credentials',async()=>{
 const {data}=await request('/health');assert.equal(data.connected,5);assert(!JSON.stringify(data).includes(token));const p=await request('/v2/progress');assert.equal(p.data.running,false);
});