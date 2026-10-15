'use strict';
// Real, bounded, user-authorized bidirectional smoke test for Google <-> iCloud.
// NEVER run on a date containing real events. Never log titles or credentials.
require('dotenv').config();
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const sync = require('../../../src/services/calendarBidirectionalSyncService');
const apple = require('../../../src/services/icloudCalDavService');
const auth = require('../../../src/services/googleCalendarAuthService');
const { createRemoteLease } = require('../../../src/services/calendarSyncRemoteLease');

const GOOGLE_ID = 'adb50694b3065cfe8bea3d5139a081f827be2c0c5e6060d14399fd7d6f33ab6b@group.calendar.google.com';
const START = new Date('2027-08-20T22:00:00.000Z');
const END = new Date('2027-08-21T22:00:00.000Z');
const API = 'https://www.googleapis.com/calendar/v3';
const RUN_MARK = 'SYNC_QA_' + randomUUID().replace(/-/g, '').slice(0, 12);
const title = suffix => RUN_MARK + '_' + suffix;
const trackedIds = new Set();
const trackedHrefs = new Set();
let googleToken = null;
let selected = null;
let mapping = null;
let lease = null;

function output(phase, facts={}) {
  console.log(JSON.stringify({ phase, ...facts }));
}

async function retryRead(fn) {
  for (let i=1;i<=3;i++) {
    try { return await fn(); }
    catch(err) {
      if (![429,502,503,504].includes(err.status) || i===3) throw err;
      await new Promise(resolve=>setTimeout(resolve, 1000*i));
    }
  }
}

function targetEvents(events, label, { includeDeleted=false }={}) {
  const outsiders=events.filter(e=>
    (includeDeleted || e.status!=='cancelled') && !String(e.summary||'').startsWith('SYNC_QA_'));
  if(outsiders.length) throw new Error('ABORT: real/unknown event in '+label+' test date');
  const test=events.filter(e => String(e.summary||'').startsWith('SYNC_QA_')
    && (includeDeleted||e.status!=='cancelled'));
  if(test.some(e=>!String(e.summary).startsWith(RUN_MARK))) {
    throw new Error('ABORT: another QA event in test date');
  }
  return test;
}

async function g(method,path,body=undefined,headers={}) {
  const url=API+path;
  const res=await fetch(url,{
    method,headers:{Authorization:'Bearer '+googleToken,'Content-Type':'application/json',...headers},
    signal:AbortSignal.timeout(30000),
    body:body===undefined?undefined:JSON.stringify(body),
  });
  const txt=await res.text();
  let data=null; if(txt){try{data=JSON.parse(txt);}catch{}}
  if(!res.ok){const error=new Error('Google '+method+' HTTP '+res.status);
    error.status=res.status;throw error;}
  return data;
}

async function listGoogle() {
  const items=[];let page='';
  do {
    const params=new URLSearchParams({timeMin:START.toISOString(),
      timeMax:END.toISOString(),singleEvents:'false',showDeleted:'true',maxResults:'2500'});
    if(page)params.set('pageToken',page);
    const result=await g('GET','/calendars/'+encodeURIComponent(GOOGLE_ID)+'/events?'+params);
    items.push(...result?.items||[]);page=result?.nextPageToken||'';
  }while(page);
  return items;
}
async function listApple() {
  return retryRead(()=>apple.fetchEventsFromCalendar(selected,START,END));
}
async function activeGoogle() {return targetEvents(await listGoogle(),'Google');}
async function activeApple() {return targetEvents(await listApple(),'iCloud');}
async function counts(expectedApple,expectedGoogle,phase) {
  const [a,b]=await Promise.all([activeApple(),activeGoogle()]);
  assert.equal(a.length,expectedApple,phase+' iCloud count');
  assert.equal(b.length,expectedGoogle,phase+' Google count');
  output(phase,{icloud:a.length,google:b.length});
  return {a,b};
}

function guardedGoogleRequest(method,path,token,body) {
  assert.equal(token,googleToken);
  const encoded=encodeURIComponent(GOOGLE_ID);
  const targetPrefix='/calendars/'+encoded+'/events';
  const lockId=process.env.CALENDAR_SYNC_LOCK_CALENDAR_ID;
  const technicalPrefix='/calendars/'+encodeURIComponent(lockId||'')+'/events';
  if(path.startsWith(technicalPrefix)) {
    if(method==='POST' && body?.extendedProperties?.private?.deletionBackup!=='v1')
      throw new Error('ABORT: unexpected technical calendar write');
    if(!['GET','POST'].includes(method)) throw new Error('ABORT: technical calendar mutation');
    return g(method,path,body);
  }
  if(!path.startsWith(targetPrefix)) throw new Error('ABORT: wrong Google calendar');
  const raw=path.slice(targetPrefix.length).split('?')[0];
  const id=raw.startsWith('/')?decodeURIComponent(raw.slice(1)):'';
  if(method==='POST') {
    if(id || !String(body?.summary||'').startsWith(RUN_MARK))
      throw new Error('ABORT: unapproved Google create');
    return g(method,path,body).then(event=>{
      if(!event?.id)throw new Error('Google POST without ID');
      trackedIds.add(event.id);
      return event;
    });
  }
  if(method==='PATCH' || method==='DELETE') {
    if(!trackedIds.has(id))throw new Error('ABORT: Google edit outside created QA IDs');
    if(body?.summary && !String(body.summary).startsWith(RUN_MARK))
      throw new Error('ABORT: Google title outside test marker');
  }
  if(method==='GET' && id && !trackedIds.has(id))
    throw new Error('ABORT: Google lookup outside created QA IDs');
  return g(method,path,body);
}
const savedPut=apple.putCalendarObject;
const savedDelete=apple.deleteCalendarObject;
function guardApple() {
  apple.putCalendarObject=async args=>{
    if(!args.url.startsWith(selected.url)
       || !String(args.ics||'').includes(RUN_MARK)
       || (!args.createOnly && !trackedHrefs.has(args.url))) {
      throw new Error('ABORT: iCloud write outside QA resources');
    }
    const result=await savedPut(args);
    trackedHrefs.add(args.url);
    return result;
  };
  apple.deleteCalendarObject=async args=>{
    if(!trackedHrefs.has(args.url) || !args.etag)
      throw new Error('ABORT: iCloud delete outside QA resources');
    return savedDelete(args);
  };
}
function unguardApple(){
  apple.putCalendarObject=savedPut;
  apple.deleteCalendarObject=savedDelete;
}
function ics(uid,summary,note,from,to) {
  const now='20261015T180000Z';
  return [
    'BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Belenciaga Calendar Sync QA//ES',
    'BEGIN:VEVENT','UID:'+uid,'DTSTAMP:'+now,'LAST-MODIFIED:'+now,
    'SUMMARY:'+summary,'DESCRIPTION:'+note,
    'DTSTART:'+from,'DTEND:'+to,
    'TRANSP:TRANSPARENT','END:VEVENT','END:VCALENDAR','',
  ].join('\r\n');
}
async function singlePass() {
  const a=await activeApple();
  const gitems=await listGoogle();
  targetEvents(gitems,'Google',{includeDeleted:false});
  // Even a cancelled unrelated event is not a reason to write to it;
  // prevent mutations of unknown IDs regardless of its presence.
  const actions=await sync._private.syncCalendarPair({
    mapping,calendar:selected,icloudEvents:a,token:googleToken,
    start:START,end:END,dryRun:false,request:guardedGoogleRequest,
    googleDeletesToIcloud:true,pruneManagedGoogleOrphans:true,
  });
  return actions.map(x=>x.type);
}
async function cleanup() {
  const failures=[];
  try {
    for(const e of await listApple()){
      if(!String(e.summary||'').startsWith(RUN_MARK)) continue;
      if(!trackedHrefs.has(e.href)) { failures.push('untracked Apple QA resource');continue; }
      try { await savedDelete({url:e.href,etag:e.etag}); }
      catch(err) { if(![404,410].includes(err.status)) failures.push('Apple cleanup HTTP '+(err.status||'unknown')); }
    }
  }catch(e){failures.push('Apple cleanup read: '+e.message);}
  try {
    for(const e of await listGoogle()){
      if(e.status==='cancelled' || !String(e.summary||'').startsWith(RUN_MARK))continue;
      if(!trackedIds.has(e.id)){failures.push('untracked Google QA ID');continue;}
      const path='/calendars/'+encodeURIComponent(GOOGLE_ID)+'/events/'+encodeURIComponent(e.id)+'?sendUpdates=none';
      try {await g('DELETE',path);}
      catch(err){if(![404,410].includes(err.status)) failures.push('Google cleanup HTTP '+(err.status||'unknown'));}
    }
  }catch(e){failures.push('Google cleanup read: '+e.message);}
  return failures;
}
async function main() {
  if(process.env.SYNC_SMOKE_APPLY!=='true')throw new Error('Refusing writes without explicit smoke-test flag');
  if(process.env.CALENDAR_SYNC_ENFORCE_ALLOWLIST!=='true')throw new Error('Strict allowlist must be enabled');
  const mappings=sync.getCalendarMap().filter(x=>sync._private.normalizeName(x.icloudName).startsWith('planes'));
  if(mappings.length!==1 || mappings[0].googleCalendarId!==GOOGLE_ID)
    throw new Error('Incorrect plans mapping');
  mapping=mappings[0];
  const calendars=(await retryRead(()=>apple.discoverCalendars())).filter(x=>
    sync._private.normalizeName(x.name)===sync._private.normalizeName(mapping.icloudName));
  if(calendars.length!==1)throw new Error('iCloud plans calendar absent/ambiguous');
  selected=calendars[0];
  googleToken=await auth.getAccessToken();
  const initialApple=await listApple(),initialGoogle=await listGoogle();
  if(initialApple.length || initialGoogle.some(x=>x.status!=='cancelled'))
    throw new Error('ABORT: test date is not empty on both calendars');
  output('preflight-empty',{icloud:0,google:0});
  lease=createRemoteLease({writerId:'bidirectional-smoke-20261015'});
  await lease.acquire();
  guardApple();
  let failure=null;
  try{
    // iCloud -> Google: create, update, delete.
    const uid='qa-'+RUN_MARK.toLowerCase()+'@calendar-sync';
    const href=new URL(encodeURIComponent(uid)+'.ics',selected.url).href;
    await apple.putCalendarObject({url:href,createOnly:true,
      ics:ics(uid,title('APPLE_CREATED'),'QA iCloud create','20270821T081000Z','20270821T084000Z')});
    await counts(1,0,'apple-created');
    let ops=await singlePass();
    assert(ops.includes('create_google'),'iCloud->Google create did not sync: '+ops);
    const cg=await counts(1,1,'icloud-to-google-create-PASS');
    assert.equal(cg.b[0].summary,title('APPLE_CREATED'));
    trackedIds.add(cg.b[0].id);

    let current=(await activeApple())[0];
    await apple.putCalendarObject({url:href,etag:current.etag,
      ics:ics(uid,title('APPLE_UPDATED'),'QA iCloud update','20270821T081000Z','20270821T084000Z')});
    ops=await singlePass();
    assert(ops.includes('update_google'),'iCloud->Google update did not sync: '+ops);
    const ug=await counts(1,1,'icloud-to-google-update-PASS');
    assert.equal(ug.b[0].summary,title('APPLE_UPDATED'));

    current=ug.a[0];
    await apple.deleteCalendarObject({url:href,etag:current.etag});
    ops=await singlePass();
    assert(ops.includes('delete_google_orphan') || ops.includes('skip_google_already_deleted'),
      'iCloud->Google delete did not sync: '+ops);
    await counts(0,0,'icloud-to-google-delete-PASS');
    await singlePass();
    await counts(0,0,'icloud-to-google-no-resurrection-PASS');

    // Google -> iCloud: create, update, delete with durable backup.
    const base='/calendars/'+encodeURIComponent(GOOGLE_ID)+'/events';
    const created=await guardedGoogleRequest('POST',base+'?sendUpdates=none',googleToken,{
      summary:title('GOOGLE_CREATED'),description:'QA Google create',
      start:{dateTime:'2027-08-21T10:10:00Z'},end:{dateTime:'2027-08-21T10:40:00Z'},
      transparency:'transparent',
    });
    assert(created?.id);
    ops=await singlePass();
    assert(ops.includes('create_icloud'),'Google->iCloud create did not sync: '+ops);
    const ag=await counts(1,1,'google-to-icloud-create-PASS');
    assert.equal(ag.a[0].summary,title('GOOGLE_CREATED'));
    trackedHrefs.add(ag.a[0].href);

    await guardedGoogleRequest('PATCH',base+'/'+encodeURIComponent(created.id)+'?sendUpdates=none',googleToken,{
      summary:title('GOOGLE_UPDATED'),description:'QA Google updated',
    });
    ops=await singlePass();
    assert(ops.includes('update_icloud'),'Google->iCloud update did not sync: '+ops);
    const upd=await counts(1,1,'google-to-icloud-update-PASS');
    assert.equal(upd.a[0].summary,title('GOOGLE_UPDATED'));

    await guardedGoogleRequest('DELETE',base+'/'+encodeURIComponent(created.id)+'?sendUpdates=none',googleToken);
    ops=await singlePass();
    assert(ops.includes('delete_icloud'),'Google->iCloud delete did not sync: '+ops);
    await counts(0,0,'google-to-icloud-delete-PASS');
    await singlePass();
    await counts(0,0,'google-to-icloud-no-resurrection-PASS');
    output('SMOKE_ALL_6_DIRECTIONS_STEPS_PASS',{created:2,updated:2,deleted:2});
  }catch(err){failure=err;output('SMOKE_FAILED',{reason:String(err.message).slice(0,250)});}
  finally {
    unguardApple();
    const errors=await cleanup();
    try {
      const [aa, gg]=await Promise.all([listApple(),listGoogle()]);
      const remainA=aa.filter(x=>String(x.summary||'').startsWith(RUN_MARK)).length;
      const remainG=gg.filter(x=>x.status!=='cancelled'&&String(x.summary||'').startsWith(RUN_MARK)).length;
      output('FINAL_CLEANUP',{remainingApple:remainA,remainingGoogle:remainG,cleanupErrors:errors.length});
      if(remainA||remainG||errors.length)
        failure ||= new Error('QA leftovers or cleanup errors detected');
    }catch(err){failure ||= new Error('Cleanup verification unavailable: '+err.message);}
    if(lease) await lease.release();
  }
  if(failure)throw failure;
}
main().catch(error=>{console.error('[smoke-test] '+String(error.message).slice(0,280));process.exitCode=1;});
