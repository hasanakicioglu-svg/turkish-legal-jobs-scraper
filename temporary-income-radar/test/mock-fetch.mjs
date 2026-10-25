// Only activated by isolated integration tests. No external request is made.
const respond=(d)=>new Response(JSON.stringify(d),{status:200,headers:{'Content-Type':'application/json'}});
globalThis.fetch=async function(url){
 const u=String(url);
 await new Promise(r=>setTimeout(r,4));
 if(u.includes('remotive.com/api/remote-jobs'))return respond({jobs:[{id:10,title:'Turkish Response Quality Reviewer',company_name:'Mock Company',url:'https://example.org/role/a',description:'Evaluate Turkish language AI response quality and fact checking',candidate_required_location:'Turkey',publication_date:'2026-10-25'}]});
 if(u.includes('himalayas.app/jobs/api/search'))return respond({jobs:[{guid:'/companies/mock/jobs/b',title:'Remote Document Research Analyst',companyName:'Mock Research',applicationLink:'https://himalayas.app/companies/mock/jobs/b',description:'Document research and analysis',locationRestrictions:['Turkey'],pubDate:'2026-10-25'}]});
 if(u.includes('remoteok.com/api'))return respond([{id:30,position:'Remote Fact Checker',company:'Mock Studio',url:'https://example.org/role/c',description:'Fact checking and quality',location:'Worldwide',date:'2026-10-25'}]);
 if(u.includes('jobicy.com/api/'))return respond({jobs:[{id:40,jobTitle:'Operations Assistant',companyName:'Mock Co',url:'https://example.org/role/d',jobDescription:'Remote operations assistant',jobGeo:'Worldwide',pubDate:'2026-10-25'}]});
 if(u.includes('arbeitnow.com/api/job-board-api'))return respond({data:[{slug:'e',title:'Data Annotation Reviewer',company_name:'Mock Ops',url:'https://example.org/role/e',description:'Data annotation and checking',location:'Turkey',remote:true,created_at:'2026-10-25'}]});
 return new Response(JSON.stringify({error:'unexpected URL '+u}),{status:404});
};