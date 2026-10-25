import http from 'node:http';
import { URL } from 'node:url';

const PORT = Number(process.env.PORT || 3000);
const TOKEN = process.env.RADAR_RUN_TOKEN || '';
const BRAVE = process.env.BRAVE_SEARCH_API_KEY || '';
const HOURS = 6 * 60 * 60 * 1000;
const sources = [
 ['Mercor','mercor.com'], ['micro1','micro1.ai'], ['Turing','turing.com'],
 ['AfterQuery','afterquery.com'], ['DataAnnotation','dataannotation.tech'],
 ['Mindrift','mindrift.ai'], ['Outlier AI','outlier.ai'], ['Prolific','prolific.com'],
 ['Terac','terac.com'], ['LinkedIn','linkedin.com/jobs'], ['Welo Data','welodata.ai'],
 ['RWS','rws.com'], ['OneForma','oneforma.com'], ['iMerit','imerit.net'],
 ['Alignerr','alignerr.com'], ['TSMG','tsmg.com'], ['TELUS Digital','telusdigital.com'],
 ['Appen','appen.com'], ['Clickworker','clickworker.com'], ['Toloka','toloka.ai'],
 ['Welocalize','welocalize.com'], ['Productive Playhouse','productiveplayhouse.com']
].map(([name,domain])=>({name,domain}));
const terms=['Turkish language','Turkish evaluator','document reviewer','data annotator','data quality','research analyst','fact checker','content reviewer','search quality','operations assistant','customer support','virtual assistant','data entry','AI trainer','legal reviewer'];
const groups=[
 ['Turkish & languages', /turkish|türkçe|locali[sz]|bilingual|language evaluat|proofread|translat|transcrib/i],
 ['Document & legal', /document|legal|contract|lawyer|attorney|litigation|compliance|due diligence|policy review/i],
 ['Data & quality', /data|annotat|label|fact.check|accuracy|quality|validat|verif|evaluat|reviewer|rater|assessor/i],
 ['Research & analysis', /research|analyst|analysis|market intelligence|business insight|benchmark|information research/i],
 ['Administration & support', /administrat|assistant|operations|customer support|support specialist|coordinator|data entry|virtual assistant|workflow/i],
 ['Testing & studies', /user test|product test|survey|participant|study|interview|feedback|usability/i]
];
const excludeSkills=/(?:must|requires?|mandatory|proficient in|expertise in)\s+(?:\w+\s+){0,4}(?:python|javascript|typescript|java\b|c\+\+|software develop|machine learning engineer|registered nurse|medical licen[sc]e|us bar admission|u\.s\. bar admission)/i;
const excludeTitle=/\b(software engineer|backend developer|front.?end developer|full.?stack|data scientist|machine learning engineer|registered nurse|physician|medical doctor|pharmacist|accountant CPA)\b/i;
const turkey=/t[uü]rk(?:ey|iye)|\bistanbul\b|\bankara\b/i;
const anywhere=/\b(worldwide|anywhere|global remote|work from anywhere|all countries)\b/i;
const regionOnly=/\b(us only|usa only|united states only|u\.s\. residents|united kingdom only|uk only|canada only|india only|philippines only|eu only|european union only)\b/i;
let snapshot=null; let currentRun=null;

function plain(v){return String(v??'').replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();}
function link(v){try{const u=new URL(String(v||''));if(!['https:','http:'].includes(u.protocol))return '';u.hash='';for(const k of [...u.searchParams.keys()])if(/^(utm_|fbclid$|gclid$|trk$)/i.test(k))u.searchParams.delete(k);return u.toString();}catch{return '';}}
function job(v){return {source:v.source,type:v.type||'api',id:String(v.id||v.url||''),title:plain(v.title),company:plain(v.company),url:link(v.url),description:plain(v.description).slice(0,12000),location:plain(v.location),restrictions:v.restrictions,published:String(v.published||''),state:v.state||'listed'};}
function assess(j){
 if(!j.title||!j.url)return null;
 const hay=(j.title+' '+j.description).slice(0,12000);
 const tags=groups.filter(([,re])=>re.test(hay)).map(([name])=>name);
 if(tags.length===0||excludeTitle.test(j.title)||excludeSkills.test(hay))return null;
 let eligibility='needs-verification';
 if(Array.isArray(j.restrictions)){
  const r=j.restrictions.map(x=>typeof x==='string'?x:JSON.stringify(x)).join(' ');
  eligibility=j.restrictions.length===0||turkey.test(r)||anywhere.test(r)?'eligible':'excluded';
 }else if(turkey.test(j.location)||anywhere.test(j.location))eligibility='eligible';
 else if(regionOnly.test(j.location))eligibility='excluded';
 if(eligibility==='excluded')return null;
 if(j.source==='Prolific')eligibility='needs-verification';
 if(j.type==='indexed')eligibility='needs-verification';
 let titleMatch=groups.some(([,re])=>re.test(j.title));
 const score=Math.min(100,(titleMatch?60:35)+8*tags.length+(eligibility==='eligible'?15:0));
 return {...j,eligibility,tags,score};
}
async function getJson(url,headers={}){
 const res=await fetch(url,{headers:{'Accept':'application/json','User-Agent':'PersonalTemporaryIncomeRadar/1.0',...headers},signal:AbortSignal.timeout(16000)});
 if(!res.ok)throw new Error(`HTTP ${res.status}`);
 return res.json();
}
async function api(name,fn){const start=Date.now();try{const {jobs,errors=[]}=await fn();return {name,status:errors.length?'partial':'ok',found:jobs.length,items:jobs,errors:errors.slice(0,3),elapsedMs:Date.now()-start};}catch(e){return {name,status:'error',found:0,items:[],reason:String(e.message).slice(0,250),elapsedMs:Date.now()-start};}}
async function remotive(){const d=await getJson('https://remotive.com/api/remote-jobs');return {jobs:(d.jobs||[]).map(x=>job({source:'Remotive',id:x.id,title:x.title,company:x.company_name,url:x.url,description:x.description,location:x.candidate_required_location,published:x.publication_date}))};}
async function himalayas(){const all=[];const errors=[];for(const q of ['Turkish','document','data annotation','research','quality','assistant','legal','evaluator']){
  try{const d=await getJson('https://himalayas.app/jobs/api/search?'+new URLSearchParams({q,country:'TR',sort:'recent',page:'1'}));
   for(const x of d.jobs||[])all.push(job({source:'Himalayas',id:x.guid||x.id,title:x.title,company:x.companyName,url:x.applicationLink||(x.guid?.startsWith('http')?x.guid:'https://himalayas.app'+(x.guid||'')),description:x.description||x.excerpt,location:(x.locationRestrictions||[]).join(', '),restrictions:x.locationRestrictions,published:x.pubDate}));
  }catch(e){errors.push(q+': '+e.message)}
 }return {jobs:all,errors};}
async function remoteok(){const d=await getJson('https://remoteok.com/api');if(!Array.isArray(d))throw new Error('Unexpected format');return {jobs:d.filter(x=>x.position).map(x=>job({source:'Remote OK',id:x.id,title:x.position,company:x.company,url:x.url||x.apply_url,description:x.description,location:x.location,published:x.date}))};}
async function jobicy(){let d;try{d=await getJson('https://jobicy.com/api/jobs?count=200');}catch(e){d=await getJson('https://jobicy.com/api/v2/remote-jobs?count=200');}
 return {jobs:(d.jobs||[]).map(x=>job({source:'Jobicy',id:x.id,title:x.jobTitle||x.title,company:x.companyName,url:x.url||x.jobUrl,description:x.jobDescription||x.description,location:x.jobGeo||x.location,published:x.pubDate}))};}
async function arbeitnow(){const d=await getJson('https://www.arbeitnow.com/api/job-board-api');return {jobs:(d.data||[]).filter(x=>x.remote===true).map(x=>job({source:'Arbeitnow',id:x.slug||x.url,title:x.title,company:x.company_name,url:x.url,description:x.description,location:x.location,published:x.created_at}))};}
async function indexed(target){if(!BRAVE)return {name:target.name,status:'not-configured',reason:'Search API key required: BRAVE_SEARCH_API_KEY',found:0,items:[]};
 return api(target.name,async()=>{const items=[],errors=[];const queries=[`site:${target.domain} (remote OR freelance) (Turkish OR document OR legal OR evaluator OR research) job`,`site:${target.domain} (remote OR contract) (data OR annotation OR reviewer OR analysis OR language) apply`];
  for(const q of queries)try{const d=await getJson('https://api.search.brave.com/res/v1/web/search?'+new URLSearchParams({q,count:'20'}),{'X-Subscription-Token':BRAVE});
   for(const x of d.web?.results||[]){const u=link(x.url);if(!u)continue;const host=new URL(u).hostname.toLowerCase();const domain=target.domain.split('/')[0];if(!(host===domain||host.endsWith('.'+domain)))continue;
   items.push(job({source:target.name,type:'indexed',url:u,title:x.title,company:target.name,description:x.description,state:'unverified-indexed-lead'}));}
  }catch(e){errors.push(e.message)}
  return {jobs:items,errors};
 }).then(x=>({...x,status:x.status==='ok'?'partial':x.status,reason:x.status==='ok'?'Indexed search: original job status and Türkiye eligibility must be verified':x.reason}));}
async function pool(list,fn,parallel=4){let i=0;const out=new Array(list.length);await Promise.all(Array.from({length:Math.min(parallel,list.length)},async()=>{while(i<list.length){const k=i++;out[k]=await fn(list[k]);}}));return out;}
async function scan(){
 const primary=await Promise.all([api('Remotive',remotive),api('Himalayas',himalayas),api('Remote OK',remoteok),api('Jobicy',jobicy),api('Arbeitnow',arbeitnow)]);
 const indexedResults=await pool(sources,indexed,4);
 const result=[...primary,...indexedResults];
 const byUrl=new Map();
 for(const src of result)for(const raw of src.items||[]){const j=assess(raw);if(!j)continue;const key=j.url.toLowerCase();if(!byUrl.has(key)||byUrl.get(key).score<j.score)byUrl.set(key,j);}
 const jobs=[...byUrl.values()].sort((a,b)=>b.score-a.score);
 return {scannedAt:new Date().toISOString(),summary:{sources:result.length,ok:result.filter(x=>x.status==='ok').length,partial:result.filter(x=>x.status==='partial').length,unconfigured:result.filter(x=>x.status==='not-configured').length,errors:result.filter(x=>x.status==='error').length,reviewableJobs:jobs.length},sources:result.map(({items,...rest})=>rest),jobs};
}
function send(res,data,status=200){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));}
function auth(req){return TOKEN && req.headers.authorization===`Bearer ${TOKEN}`;}
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Temporary Income Radar</title><style>
:root{color-scheme:light;font-family:system-ui,-apple-system,Arial,sans-serif;color:#1c2e45;background:#f5f7fc}*{box-sizing:border-box}body{max-width:1250px;margin:auto;padding:24px}h1{margin:0;font-size:28px}header{display:flex;gap:12px;justify-content:space-between;align-items:center;flex-wrap:wrap}p{line-height:1.5}header p,.muted{color:#617187}.row{display:flex;flex-wrap:wrap;gap:10px;margin:16px 0}.pill,input,select,button{background:white;color:#23354d;border:1px solid #d4dde9;padding:10px 12px;border-radius:9px}button{cursor:pointer}button.primary{background:#185ad5;border-color:#185ad5;color:white}input[type=search]{flex:1;min-width:250px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(310px,1fr));gap:14px}.card{background:white;border:1px solid #dfe7f1;border-radius:13px;padding:17px}.card h3{font-size:18px;margin:8px 0}.card a{color:#1156bc}.small{font-size:12px}.badge{display:inline-block;padding:3px 8px;border-radius:6px;background:#e8edf5;font-size:12px;margin:3px}.good{background:#dff5e8;color:#115730}.warn{background:#fff0cb;color:#845400}.bad{color:#ad2828}details{margin-top:24px}table{width:100%;border-collapse:collapse;background:white}td,th{border:1px solid #dfe7f1;padding:8px;text-align:left;font-size:13px}button:disabled{opacity:.5}#msg{color:#324968}small{font-size:12px}@media(max-width:640px){body{padding:14px}h1{font-size:22px}}
</style></head><body><header><div><h1>Temporary Income Radar</h1><p>Remote work from Türkiye · any seniority · legal and non-legal · no auto-applications</p></div><button id="scan" class="primary">Run source scans</button></header>
<div class="row" id="summary"><span class="pill">No scan yet</span></div><div class="row"><input type="search" id="query" placeholder="Find a skill, company or role"><select id="elig"><option value="">All potential matches</option><option value="eligible">Türkiye eligible (source indication)</option><option value="needs-verification">Eligibility needs verification</option></select><label class="pill"><input type="checkbox" id="completed"> Show completed</label></div><p id="msg"></p><main class="grid" id="list"></main><details><summary><strong>Independent source audit</strong> — click to see successes, failures and missing integrations</summary><table><thead><tr><th>Source</th><th>Status</th><th>Found</th><th>Reason</th></tr></thead><tbody id="audit"></tbody></table></details><p class="muted"><small>Sources include Remotive, Himalayas, Remote OK, Jobicy, Arbeitnow and indexed searches of 22 specialist platforms (when configured). Indexed entries are unverified leads, not guaranteed vacancies. "Applied" and "Don't show" choices stay in this browser. No CV is sent to external job websites.</small></p>
<script>
const el=id=>document.getElementById(id);let all=[];let cache=null;const states=()=>{try{return JSON.parse(localStorage.getItem('tir-v1-status')||'{}')}catch{return {}}};function state(id){return states()[id]||'new'};const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function load(){try{const d=await(await fetch('/v1/jobs')).json();cache=d;all=d.jobs||[];el('summary').innerHTML=d.summary?'<span class="pill">Last scan: '+esc(d.scannedAt)+'</span><span class="pill">Matches: '+d.summary.reviewableJobs+'</span><span class="pill">Sources: '+d.summary.sources+'</span><span class="pill">Not configured: '+d.summary.unconfigured+'</span><span class="pill">Errors: '+d.summary.errors+'</span>':'<span class="pill">No scan yet — press Run source scans</span>';const s=await(await fetch('/v1/sources')).json();el('audit').innerHTML=(s.sources||[]).map(x=>'<tr><td>'+esc(x.name)+'</td><td>'+esc(x.status)+'</td><td>'+esc(x.found||0)+'</td><td>'+esc(x.reason||(x.errors||[]).join(' ; '))+'</td></tr>').join('');show()}catch(e){el('msg').textContent=e.message}}
function show(){const q=el('query').value.toLowerCase(),e=el('elig').value,done=el('completed').checked,st=states();const filtered=all.filter(j=>(done||!['applied','dismissed'].includes(st[j.url]))&&(!e||j.eligibility===e)&&(!q||(j.title+' '+j.company+' '+j.description+' '+j.tags.join(' ')).toLowerCase().includes(q)));el('list').innerHTML=filtered.length?filtered.map((j,i)=>'<article class="card" data-url="'+esc(j.url)+'"><div class="muted small">'+esc(j.source)+' · '+esc(j.company)+' '+(j.published?'· '+esc(j.published.slice(0,10)):'')+'</div><h3><a href="'+esc(j.url)+'" rel="noopener noreferrer" target="_blank">'+esc(j.title)+'</a></h3><span class="badge '+(j.eligibility==='eligible'?'good':'warn')+'">'+(j.eligibility==='eligible'?'Türkiye source match':'Check Türkiye eligibility')+'</span><span class="badge">'+esc(j.state)+'</span><p>'+esc(j.description.slice(0,320))+'</p><div>'+j.tags.map(t=>'<span class="badge">'+esc(t)+'</span>').join('')+'</div><div class="row"><button data-act="seen">Seen</button><button data-act="applied">Applied</button><button data-act="dismissed">Don\'t show</button></div></article>').join(''):'<p>No jobs match these filters. Check the independent source audit.</p>';}
el('list').addEventListener('click',event=>{const b=event.target.closest('button[data-act]');if(!b)return;const card=b.closest('article[data-url]');if(!card)return;const s=states();s[card.dataset.url]=b.dataset.act;localStorage.setItem('tir-v1-status',JSON.stringify(s));show()});el('query').oninput=show;el('elig').onchange=show;el('completed').onchange=show;
el('scan').onclick=async()=>{let token=sessionStorage.getItem('tir-v1-token')||prompt('Enter your Temporary Income Radar run token:')||'';if(!token)return;el('scan').disabled=true;el('msg').textContent='Scanning independent sources…';try{const r=await fetch('/v1/scan',{method:'POST',headers:{Authorization:'Bearer '+token}});if(!r.ok){if(r.status===401)sessionStorage.removeItem('tir-v1-token');throw new Error('Scan failed (HTTP '+r.status+')')}sessionStorage.setItem('tir-v1-token',token);await load();el('msg').textContent='Scan complete. See source audit for coverage and missing integrations.'}catch(e){el('msg').textContent=e.message}finally{el('scan').disabled=false}};
load();
</script></body></html>`;

http.createServer(async(req,res)=>{try{
 const u=new URL(req.url,'http://localhost');
 if(req.method==='GET'&&(u.pathname==='/'||u.pathname==='/dashboard')){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'"});res.end(html);return;}
 if(req.method==='GET'&&u.pathname==='/health')return send(res,{ok:true,scannedAt:snapshot?.scannedAt||null,sourceCount:sources.length+5,indexedConfigured:!!BRAVE});
 if(req.method==='GET'&&u.pathname==='/v1/jobs')return send(res,{scannedAt:snapshot?.scannedAt||null,summary:snapshot?.summary||null,jobs:snapshot?.jobs||[]});
 if(req.method==='GET'&&u.pathname==='/v1/sources')return send(res,{sources:snapshot?.sources||sources.map(x=>({name:x.name,status:BRAVE?'not-scanned':'not-configured',reason:BRAVE?'Awaiting scan':'Search provider key required'})),searchConfigured:!!BRAVE});
 if(req.method==='POST'&&u.pathname==='/v1/scan'){
  if(!auth(req))return send(res,{error:'Unauthorized'},401);
  if(snapshot&&Date.now()-Date.parse(snapshot.scannedAt)<HOURS)return send(res,{...snapshot,cached:true});
  if(!currentRun)currentRun=scan().then(x=>(snapshot=x,x)).finally(()=>{currentRun=null});
  return send(res,await currentRun);
 }
 return send(res,{error:'Not found'},404);
 }catch(e){return send(res,{error:String(e.message).slice(0,200)},500)}
}).listen(PORT,'0.0.0.0',()=>console.log('Temporary Income Radar on port '+PORT));