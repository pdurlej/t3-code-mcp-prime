import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Mailbox } from '../dist/mailbox.js';
import { WorkflowService, mailboxBinding } from '../dist/workflow.js';
function setup(t) {
  const dir=mkdtempSync(join(tmpdir(),'prime-workflow-'));
  const projection=new Map(),sent=[],reply={value:null}; let mode='busy';
  const prime={store:{thread(id){return {thread_id:id};},one(sql,id){return projection.get(id);}},async call(name,a){
    if(name==='wait_for_turn') return reply.value ?? {reply:null,replyState:'missing'};
    sent.push(a);
    if(mode==='error') throw Error('sensitive upstream details');
    if(mode==='ok') projection.set(a.requestId,{thread_id:a.threadId,role:'user',text:a.message});
    return {accepted:mode!=='busy'};
  }};
  let b=new Mailbox('instance',dir);
  let service=new WorkflowService(prime,()=>b,()=>({pair:{writerThreadId:'writer',reviewerThreadId:'reviewer'}}));
  t.after(()=>{b.close();rmSync(dir,{recursive:true,force:true});});
  return {get b(){return b;}, get service(){return service;},sent,reply,projection,setMode(m){mode=m;},due(){b.db.exec('UPDATE outbox SET next_attempt=0');},restart(){b.close();b=new Mailbox('instance',dir);service=new WorkflowService(prime,()=>b,()=>({pair:{writerThreadId:'writer',reviewerThreadId:'reviewer'}}));},dir};
}
test('durable busy and ambiguous sends survive restart; exact ID/body and deletion only after projection',async t=>{
 const f=setup(t),id=randomUUID(),args={threadId:'writer',requestId:id,message:'original body'};
 await f.service.call('queue_message',args);
 await f.service.call('deliver_pending',{});
 assert.equal(f.b.mail(id).text,args.message);
 f.restart();f.due();f.setMode('error');await f.service.call('deliver_pending',{});
 assert.equal(f.b.mail(id).status,'pending');assert.ok(!JSON.stringify(await f.service.call('delivery_status',{})).includes('sensitive'));
 f.setMode('accepted');f.due();await f.service.call('deliver_pending',{});assert.equal(f.b.mail(id).text,args.message);
 f.setMode('ok');f.due();await f.service.call('deliver_pending',{});
 assert.equal(f.b.mail(id).status,'delivered');assert.equal(f.b.mail(id).text,null);
 assert.ok(f.sent.every(a=>a.requestId===id&&a.message===args.message));
 await assert.rejects(()=>f.service.call('queue_message',{...args,message:'different'}));
});
test('action event closes review, feedback, and disposition without generating another review',async t=>{
 const f=setup(t);f.setMode('ok');
 const event={routeId:'pair',eventId:'dirty-change-1',kind:'problem',workRef:'HEAD abc; diff sha256:def; artifact /local/review.diff',summary:'Review the change'};
 const r=await f.service.call('request_review',event);
 assert.equal((await f.service.call('request_review',event)).reviewId,r.reviewId);
 await assert.rejects(()=>f.service.call('request_review',{...event,summary:'different'}));
 await assert.rejects(()=>f.service.call('request_review',{...event,eventId:'next'}));
 await f.service.call('deliver_pending',{});assert.equal(f.b.review(r.reviewId).phase,'reviewing');
 f.restart(); f.reply.value={replyState:'streaming',reply:null};await f.service.call('deliver_pending',{});assert.equal(f.sent.length,1);
 f.reply.value={replyState:'ready',reply:{messageId:'reply-exact',text:'Fix X',nextOffset:null}};
 await f.service.call('deliver_pending',{});assert.equal(f.b.review(r.reviewId).phase,'awaiting_resolution');
 const resolution={reviewId:r.reviewId,dispositions:[{finding:'X',decision:'adopted',reason:'fixed',evidence:'test passes at abc'}]};
 await f.service.call('resolve_review',resolution);await f.service.call('deliver_pending',{});
 assert.equal(f.b.review(r.reviewId).phase,'closed');assert.equal(f.sent.length,3);
 await f.service.call('resolve_review',resolution);await f.service.call('deliver_pending',{});assert.equal(f.sent.length,3);
 await f.service.call('request_review',{...event,eventId:'dirty-change-2',workRef:'same HEAD abc; new dirty diff hash:ghi'});
 assert.equal(f.b.db.prepare('SELECT count(*) n FROM reviews').get().n,2);
});
test('mailbox binding and process lease prevent accidental second-instance drain',t=>{
 const f=setup(t);assert.throws(()=>new Mailbox('another',f.dir));
 const second=new Mailbox('instance',f.dir);
 try {assert.equal(f.b.acquire('a'),true);assert.equal(second.acquire('b'),false);f.b.release('a');assert.equal(second.acquire('b'),true);}finally{second.close();}
});
test('later message cannot overtake a backed-off message to the same thread',async t=>{
 const f=setup(t),first=randomUUID(),second=randomUUID();
 await f.service.call('queue_message',{threadId:'writer',requestId:first,message:'first'});
 await f.service.call('deliver_pending',{});
 await f.service.call('queue_message',{threadId:'writer',requestId:second,message:'second'});
 f.setMode('ok');await f.service.call('deliver_pending',{});assert.equal(f.sent.length,1);
 f.due();await f.service.call('deliver_pending',{});assert.equal(f.b.mail(first).status,'delivered');assert.equal(f.b.mail(second).status,'pending');
 await f.service.call('deliver_pending',{});assert.equal(f.b.mail(second).status,'delivered');
});
test('already projected message is confirmed without another dispatch',async t=>{
 const f=setup(t),id=randomUUID();await f.service.call('queue_message',{threadId:'writer',requestId:id,message:'exact'});
 f.projection.set(id,{thread_id:'writer',role:'user',text:'exact'});
 await f.service.call('deliver_pending',{});assert.equal(f.sent.length,0);assert.equal(f.b.mail(id).text,null);
});
test('stuck reviewer can be cancelled without another automatic message',async t=>{
 const f=setup(t);f.setMode('ok');
 const r=await f.service.call('request_review',{routeId:'pair',eventId:'blocked',kind:'ready',workRef:'abc',summary:'review'});
 await f.service.call('deliver_pending',{});
 f.reply.value={outcome:'completed',replyState:'missing',reply:null};await f.service.call('deliver_pending',{});
 await f.service.call('cancel_review',{reviewId:r.reviewId,reason:'No usable reply'});
 f.reply.value={replyState:'ready',reply:{text:'late reply',messageId:'late'}};await f.service.call('deliver_pending',{});
 assert.equal(f.sent.length,1);assert.equal(f.b.review(r.reviewId).phase,'cancelled');
 await f.service.call('request_review',{routeId:'pair',eventId:'replacement',kind:'ready',workRef:'abc',summary:'review again'});
});
test('cancellation cannot discard ambiguous outgoing delivery or race active worker',async t=>{
 const f=setup(t);
 const r=await f.service.call('request_review',{routeId:'pair',eventId:'ambiguous',kind:'ready',workRef:'abc',summary:'review'});
 f.b.acquire('worker');await assert.rejects(()=>f.service.call('cancel_review',{reviewId:r.reviewId,reason:'stop'}));f.b.release('worker');
 f.setMode('error');await f.service.call('deliver_pending',{});
 await assert.rejects(()=>f.service.call('cancel_review',{reviewId:r.reviewId,reason:'stop'}));
 assert.ok(f.b.mail(f.b.review(r.reviewId).request_id).text);
});

test('binding follows database identity, not desktop port, while explicit origins remain pinned',t=>{
 const f=setup(t),path=join(f.dir,'t3.sqlite');writeFileSync(path,'fixture');
 const oldDb=process.env.T3_DATABASE,oldOrigin=process.env.T3_ORIGIN;
 try {
   process.env.T3_DATABASE=path;delete process.env.T3_ORIGIN;
   const desktop=mailboxBinding();assert.equal(mailboxBinding(),desktop);
   process.env.T3_ORIGIN='http://localhost:3773';const explicit=mailboxBinding();assert.notEqual(explicit,desktop);
   process.env.T3_ORIGIN='http://localhost:3774';assert.notEqual(mailboxBinding(),explicit);
   delete process.env.T3_ORIGIN;renameSync(path,path+'.old');writeFileSync(path,'replacement');assert.notEqual(mailboxBinding(),desktop);
 } finally {if(oldDb===undefined)delete process.env.T3_DATABASE;else process.env.T3_DATABASE=oldDb;if(oldOrigin===undefined)delete process.env.T3_ORIGIN;else process.env.T3_ORIGIN=oldOrigin;}
});
