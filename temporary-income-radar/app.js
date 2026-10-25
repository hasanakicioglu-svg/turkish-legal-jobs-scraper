import http from 'node:http';
import { URL } from 'node:url';
import { readFileSync } from 'node:fs';

const PORT = Number(process.env.PORT || 3000);
const TOKEN = process.env.RADAR_RUN_TOKEN || '';
// No commercial search API is required. Each source is checked separately.
const HOURS = 2 * 60 * 60 * 1000;
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
  eligibility=j.restrictions.length===0?'needs-verification':(turkey.test(r)||anywhere.test(r)?'eligible':'excluded');
 }else if(turkey.test(j.location)||anywhere.test(j.location))eligibility='eligible';
 else if(regionOnly.test(j.location))eligibility='excluded';
 if(eligibility==='excluded')return null;
 if(j.source==='Prolific')eligibility='needs-verification';
 if(j.type==='manual')eligibility='needs-verification';
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
const extraSites = [
 ['Indeed','indeed.com'],['Glassdoor','glassdoor.com'],['We Work Remotely','weworkremotely.com'],
 ['FlexJobs','flexjobs.com'],['Upwork','upwork.com'],['Contra','contra.com'],
 ['Freelancer','freelancer.com'],['PeoplePerHour','peopleperhour.com'],
 ['UserTesting','usertesting.com'],['Respondent','respondent.io'],['User Interviews','userinterviews.com']
];
const apiConnectors={Remotive:remotive,Himalayas:himalayas,'Remote OK':remoteok,Jobicy:jobicy,Arbeitnow:arbeitnow};
const catalogue=[];
const searchGroups=[
 {id:'ai-experts',title:'AI expert and project platforms',members:['Mercor','micro1','Turing','AfterQuery']},
 {id:'ai-evaluation',title:'AI evaluation and data labeling',members:['DataAnnotation','Mindrift','Outlier AI','Alignerr','Welo Data']},
 {id:'language',title:'Language, research and quality control',members:['RWS','OneForma','iMerit','TSMG','TELUS Digital','Appen','Welocalize','Productive Playhouse']},
 {id:'microtasks',title:'Studies, microtasks and project work',members:['Prolific','Terac','Clickworker','Toloka']},
 {id:'job-boards',title:'Remote job-board feeds',members:['Remotive','Himalayas','Remote OK','Jobicy','Arbeitnow']},
 {id:'other-remote',title:'Other freelance and remote marketplaces',members:['LinkedIn',...extraSites.map(x=>x[0])]}
];
const knownSites = [...sources,...extraSites.map(([name,domain])=>({name,domain})),
 ...Object.keys(apiConnectors).map(name=>({name,domain:null}))];
const normalizeId=(s)=>String(s).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
for (const group of searchGroups) {
 for (const name of group.members) {
  const s=knownSites.find(x=>x.name===name);
  if(!s)throw new Error('Missing site configuration: '+name);
  catalogue.push({id:normalizeId(name),name,groupId:group.id,group:group.title,
   mode:apiConnectors[name]?'api':'manual',
   url:s.domain?'https://'+s.domain+'/':(name==='Himalayas'?'https://himalayas.app/':'https://'+(name==='Remote OK'?'remoteok.com':name.toLowerCase()+'.com')+'/'),
   notes:name==='Prolific'?'Ordinary participant eligibility for Türkiye is not confirmed / may be unavailable.':''});
 }
}
const lastById = new Map();
const log=[];
let running=null;
function pickSources(params){
 if (params.sourceId){const x=catalogue.find(x=>x.id===params.sourceId);return x?[x]:null;}
 if (params.groupId){const g=searchGroups.find(x=>x.id===params.groupId);return g?catalogue.filter(x=>x.groupId===g.id):null;}
 if (params.allConnected===true)return catalogue.filter(x=>x.mode==='api');
 return null;
}
function cleanJobList(raw){const byUrl=new Map();for(const r of raw){const j=assess(r);if(!j)continue;const key=j.url.toLowerCase();if(!byUrl.has(key)||byUrl.get(key).score<j.score)byUrl.set(key,j);}return [...byUrl.values()].sort((a,b)=>b.score-a.score);}
function summarise(){
 const jobs=cleanJobList([...lastById.values()].flatMap(x=>x.items||[]));
 const checks=catalogue.map(x=>{
  const scan=lastById.get(x.id);
  return {id:x.id,name:x.name,groupId:x.groupId,mode:x.mode,url:x.url,
   status:scan?.status||(x.mode==='api'?'not-scanned':'not-integrated'),
   found:scan?.found||0,matched:scan?.matched||0,checkedAt:scan?.checkedAt||null,
   reason:scan?.reason||(x.mode==='manual'?'No supported automatic connector. Review this source directly.':'Not yet checked'),
   errors:scan?.errors||[],cached:scan?.cached||false,elapsedMs:scan?.elapsedMs||0};
 });
 return {lastUpdated:new Date().toISOString(),summary:{totalSources:catalogue.length,
  connectedSources:catalogue.filter(x=>x.mode==='api').length,
  checked:checks.filter(x=>x.checkedAt&&x.mode==='api').length,
  failures:checks.filter(x=>x.status==='error').length,
  notIntegrated:checks.filter(x=>x.mode==='manual').length,
  matches:jobs.length},jobs,sources:checks,history:log.slice(-100),progress:running&&{startedAt:running.startedAt,total:running.total,done:running.done,current:running.current}};
}
async function checkOne(src, force=false){
 const old=lastById.get(src.id);
 if(src.mode==='manual'){
  const data={name:src.name,status:'not-integrated',found:0,items:[],checkedAt:new Date().toISOString(),reason:'No authorized automatic connector yet; open the source directly to inspect vacancies.',elapsedMs:0};
  lastById.set(src.id,data);log.push({source:src.name,sourceId:src.id,status:data.status,at:data.checkedAt});
  return {id:src.id,source:src.name,status:data.status,found:0,matched:0};
 }
 if(!force && old && old.checkedAt && Date.now()-Date.parse(old.checkedAt)<HOURS && ['ok','partial'].includes(old.status)){
  return {id:src.id,source:src.name,status:'cached',found:old.found,matched:old.matched,checkedAt:old.checkedAt};
 }
 const data=await api(src.name,apiConnectors[src.name]);
 data.checkedAt=new Date().toISOString();data.matched=cleanJobList(data.items).length;
 if(data.status==='ok'&&data.found===0)data.reason='Checked successfully; zero source results (not necessarily zero matching roles).';
 lastById.set(src.id,data);
 log.push({source:src.name,sourceId:src.id,status:data.status,at:data.checkedAt,found:data.found,matched:data.matched,reason:data.reason||''});
 if(log.length>500)log.splice(0,log.length-500);
 return {id:src.id,source:src.name,status:data.status,found:data.found,matched:data.matched,checkedAt:data.checkedAt,reason:data.reason||'',errors:data.errors||[]};
}
async function runQueue(list,force=false){
 running={startedAt:new Date().toISOString(),total:list.length,done:0,current:null};
 const report=[];
 try {
  for(const src of list){running.current=src.name;report.push(await checkOne(src,force));running.done++;}
  return {runAt:new Date().toISOString(),mode:'sequential',checks:report,snapshot:summarise()};
 }finally{running=null;}
}
function respond(res,obj,status=200){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(obj));}
function authorized(req){return !!TOKEN && req.headers.authorization===`Bearer ${TOKEN}`;}
async function readBody(req){let data='';for await(const chunk of req){data+=chunk;if(data.length>4000)throw new Error('Request too large');}try{return JSON.parse(data||'{}');}catch{throw new Error('Invalid JSON');}}
const html=readFileSync(new URL('./dashboard.html',import.meta.url),'utf8');
http.createServer(async(req,res)=>{
 try{
  const u=new URL(req.url,'http://localhost');
  if(req.method==='GET'&&(u.pathname==='/'||u.pathname==='/dashboard')){
   res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'"});res.end(html);return;
  }
  if(req.method==='GET'&&u.pathname==='/health')return respond(res,{ok:true,version:'2.0',connected:catalogue.filter(s=>s.mode==='api').length,total:catalogue.length,running:!!running});
  if(req.method==='GET'&&u.pathname==='/v2/catalog')return respond(res,{groups:searchGroups.map(g=>({...g,memberCount:g.members.length})),sources:catalogue});
  if(req.method==='GET'&&u.pathname==='/v2/snapshot')return respond(res,summarise());
  if(req.method==='GET'&&u.pathname==='/v2/progress')return respond(res,{running:!!running,progress:running});
  if(req.method==='POST'&&u.pathname==='/v2/scan'){
   if(!authorized(req))return respond(res,{error:'Unauthorized'},401);
   if(running)return respond(res,{error:'A sequential run is already in progress',progress:running},409);
   let data;try{data=await readBody(req)}catch(e){return respond(res,{error:e.message},400)}
   const chosen=pickSources(data);
   if(!chosen||chosen.length===0)return respond(res,{error:'Select a valid source, group, or allConnected.'},400);
   // One queue per request: never use Promise.all across providers.
   return respond(res,await runQueue(chosen,data.force===true));
  }
  // v1 reads maintained for old clients, but old bulk-write endpoint intentionally disabled.
  if(req.method==='GET'&&u.pathname==='/v1/jobs'){const s=summarise();return respond(res,{scannedAt:s.lastUpdated,summary:s.summary,jobs:s.jobs});}
  if(req.method==='GET'&&u.pathname==='/v1/sources'){const s=summarise();return respond(res,{sources:s.sources,searchConfigured:false});}
  if(req.method==='POST'&&u.pathname==='/v1/scan')return respond(res,{error:'Use v2/scan with explicit sourceId or groupId; bulk parallel scans were removed.'},410);
  return respond(res,{error:'Not found'},404);
 }catch(e){return respond(res,{error:String(e.message).slice(0,250)},500);}
}).listen(PORT,'0.0.0.0',()=>console.log('Temporary Income Radar v2 listening on '+PORT));