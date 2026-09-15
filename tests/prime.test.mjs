import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ThreadStore, stateOf } from '../dist/store.js';
import { PrimeService } from '../dist/prime.js';
import { localOrigin } from '../dist/config.js';
import { acquireSendLock } from '../dist/send-lock.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(),'t3-prime-test-'));
  const path = join(dir,'state.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE projection_projects(project_id TEXT PRIMARY KEY,title TEXT,deleted_at TEXT,workspace_root TEXT);
    CREATE TABLE projection_threads(thread_id TEXT PRIMARY KEY,project_id TEXT,title TEXT,branch TEXT,latest_turn_id TEXT,updated_at TEXT,deleted_at TEXT,archived_at TEXT,pending_approval_count INTEGER DEFAULT 0,pending_user_input_count INTEGER DEFAULT 0,has_actionable_proposed_plan INTEGER DEFAULT 0);
    CREATE TABLE projection_thread_sessions(thread_id TEXT PRIMARY KEY,status TEXT,provider_name TEXT,updated_at TEXT);
    CREATE TABLE projection_turns(row_id INTEGER PRIMARY KEY,thread_id TEXT,turn_id TEXT,pending_message_id TEXT,state TEXT,completed_at TEXT);
    CREATE TABLE projection_thread_messages(message_id TEXT PRIMARY KEY,thread_id TEXT,turn_id TEXT,role TEXT,text TEXT,is_streaming INTEGER DEFAULT 0,created_at TEXT);
    INSERT INTO projection_projects VALUES('p','Project',NULL,'/workspace');
    INSERT INTO projection_threads(thread_id,project_id,title,latest_turn_id,updated_at) VALUES('t','p','Main','turn-2','2026-09-14');
    INSERT INTO projection_thread_sessions VALUES('t','ready','codex','2026-09-14');
    INSERT INTO projection_turns VALUES(1,'t','turn-1','req-1','completed','2026-09-13'),(2,'t','turn-2','req-2','interrupted','2026-09-14');
    INSERT INTO projection_thread_messages VALUES('req-1','t',NULL,'user','First question',0,'01'),('reply-1','t','turn-1','assistant','Correct first answer',0,'02'),('req-2','t',NULL,'user','Second question',0,'03'),('reply-2','t','turn-2','assistant','Interrupted second answer',0,'04');`);
  const store = new ThreadStore(path);
  const service = new PrimeService(store,()=>{ throw new Error('network not expected'); },async()=>({reachable:true}));
  t.after(()=>{store.close();db.close();rmSync(dir,{recursive:true,force:true});});
  return {db,store,service,dir};
}

test('completed, interrupted, blocked, and starting are distinct',()=>{
  assert.equal(stateOf({turn_state:'completed'}),'completed');
  assert.equal(stateOf({turn_state:'interrupted'}),'interrupted');
  assert.equal(stateOf({turn_state:'completed',session_status:'starting'}),'starting');
  assert.equal(stateOf({turn_state:'running',pending_approval_count:1}),'needs-approval');
});

test('store cannot mutate T3',t=>{
  const {store,db}=fixture(t);
  assert.throws(()=>store.db.exec("DELETE FROM projection_thread_messages"));
  assert.equal(db.prepare('SELECT count(*) AS n FROM projection_thread_messages').get().n,4);
});

test('Unicode content search returns matching offset and stable identity, not only titles',async t=>{
  const {db,service}=fixture(t);
  db.prepare("UPDATE projection_thread_messages SET text=? WHERE message_id='reply-1'").run('a'.repeat(500)+' ŻÓŁĆ pamięć '+'z'.repeat(500));
  const r=await service.call('search_messages',{query:'żółć PAMIĘĆ',snippetChars:80,limit:1});
  assert.equal(r.matches[0].messageId,'reply-1');
  assert.ok(r.matches[0].text.includes('ŻÓŁĆ'));
  assert.equal(r.matches[0].text.length,80);
  assert.ok(r.matches[0].offset>0);
  assert.equal(r.matches[0].turnId,'turn-1');
});

test('search is literal, scoped, and paginated',async t=>{
  const {service}=fixture(t);
  assert.equal((await service.call('search_messages',{query:"%' OR 1=1 --"})).matches.length,0);
  assert.equal((await service.call('search_messages',{query:'question',projectId:'other'})).matches.length,0);
  const a=await service.call('search_messages',{query:'question',limit:1});
  const b=await service.call('search_messages',{query:'question',limit:1,offset:a.nextOffset});
  assert.notEqual(a.matches[0].messageId,b.matches[0].messageId);
  assert.equal(b.nextOffset,null);
});

test('center window and before cursor preserve chronological order without duplication',async t=>{
  const {service}=fixture(t);
  const a=await service.call('get_thread',{threadId:'t',centerMessageId:'req-2',limit:3});
  assert.deepEqual(a.messages.map(m=>m.messageId),['reply-1','req-2','reply-2']);
  const b=await service.call('get_thread',{threadId:'t',beforeMessageId:a.beforeMessageId,limit:3});
  assert.deepEqual(b.messages.map(m=>m.messageId),['req-1']);
  assert.equal(b.beforeMessageId,null);
});

test('chunked read reconstructs original long message',async t=>{
  const {db,service}=fixture(t);
  const original='Large context '+ 'abcdef'.repeat(1000);
  db.prepare("UPDATE projection_thread_messages SET text=? WHERE message_id='reply-1'").run(original);
  let offset=0,text='';
  do { const r=await service.call('get_message',{threadId:'t',messageId:'reply-1',offset,maxChars:200});text+=r.message.text;offset=r.message.nextOffset; }while(offset!==null);
  assert.equal(text,original);
  await assert.rejects(()=>service.call('get_message',{threadId:'other',messageId:'reply-1'}));
});

test('wait returns requested turn, never the latest unrelated reply',async t=>{
  const {service}=fixture(t);
  const a=await service.call('wait_for_turn',{threadId:'t',requestId:'req-1',timeoutSeconds:0});
  assert.equal(a.outcome,'completed');assert.equal(a.reply.messageId,'reply-1');assert.equal(a.taskSuccessVerified,false);
  const b=await service.call('wait_for_turn',{threadId:'t',requestId:'req-2',timeoutSeconds:0});
  assert.equal(b.outcome,'interrupted');assert.equal(b.reply.messageId,'reply-2');assert.equal(b.replyState,'partial');
});

test('unmapped or pending requests time out, no prior reply is substituted',async t=>{
  const {db,service}=fixture(t);
  db.exec("INSERT INTO projection_thread_messages VALUES('req-3','t',NULL,'user','Pending',0,'05')");
  const r=await service.call('wait_for_turn',{threadId:'t',requestId:'req-3',timeoutSeconds:0});
  assert.equal(r.outcome,'timeout');assert.equal(r.reply,undefined);assert.equal(r.requestState,'unmapped');
});

test('unavailable runtime is distinct from live work',async t=>{
  const {db,store}=fixture(t);
  db.exec("UPDATE projection_turns SET state='running' WHERE turn_id='turn-1'");
  const service=new PrimeService(store,()=>{},async()=>({reachable:false}));
  assert.equal((await service.call('wait_for_turn',{threadId:'t',requestId:'req-1',timeoutSeconds:0})).outcome,'unavailable');
});

function sender(store,thread,dispatch,lock=()=>({release(){},pending(){},reserve(){}})) {
  return new PrimeService(store,()=>({thread:async()=>({thread}),dispatch}),async()=>({reachable:true}),lock);
}
const idle={id:'t',runtimeMode:'approval-required',interactionMode:'plan',session:{status:'ready'},latestTurn:{state:'completed'}};

test('busy targets receive no dispatch',async t=>{
  const {store}=fixture(t); let sent=0;
  const s=sender(store,{...idle,session:{status:'running',activeTurnId:'live'}},async()=>{sent++;return {sequence:1};});
  const r=await s.call('send_message',{threadId:'t',message:'Hello'});
  assert.equal(r.outcome,'busy');assert.equal(r.accepted,false);assert.equal(sent,0);
});

test('pending startup is busy even before session reports running',async t=>{
  const {store,db}=fixture(t);let sent=0;
  db.exec("INSERT INTO projection_turns VALUES(3,'t',NULL,'pending','pending',NULL)");
  const s=sender(store,idle,async()=>{sent++;return {sequence:1};});
  assert.equal((await s.call('send_message',{threadId:'t',message:'Hello'})).outcome,'busy');assert.equal(sent,0);
});

test('send preserves permissions, exposes identity, and deduplicates retries',async t=>{
  const {store,db}=fixture(t);const commands=[];
  const s=sender(store,idle,async cmd=>{
    commands.push(cmd);
    db.prepare('INSERT INTO projection_thread_messages VALUES(?,?,NULL,?,?,0,?)').run(cmd.message.messageId,'t','user',cmd.message.text,'05');
    return {sequence:77};
  });
  const a=await s.call('send_message',{threadId:'t',message:'Hello'});
  const b=await s.call('send_message',{threadId:'t',message:'Hello',requestId:a.requestId});
  assert.equal(commands.length,1);assert.equal(b.deduplicated,true);
  assert.equal(commands[0].runtimeMode,'approval-required');assert.equal(commands[0].interactionMode,'plan');
  assert.equal(commands[0].commandId,a.requestId);assert.equal(commands[0].message.messageId,a.requestId);
  await assert.rejects(()=>s.call('send_message',{threadId:'t',message:'Different',requestId:a.requestId}),/another message/);
});

test('ambiguous dispatch error retains request id without reflecting error body',async t=>{
  const {store}=fixture(t);const s=sender(store,idle,async()=>{throw new Error('secret-from-server');});
  await assert.rejects(()=>s.call('send_message',{threadId:'t',message:'Hello',requestId:'9f671ebd-1c2d-42b8-9f46-6f7e323672ac'}),e=> e.message.includes('9f671ebd-1c2d-42b8-9f46-6f7e323672ac')&&!e.message.includes('secret-from-server'));
});

test('no permission defaults and no archived sends',async t=>{
  const {store,db}=fixture(t);const s=sender(store,{...idle,runtimeMode:undefined},async()=>{throw new Error('must not send');});
  await assert.rejects(()=>s.call('send_message',{threadId:'t',message:'Hello'}),/modes/);
  db.exec("UPDATE projection_threads SET archived_at='today' WHERE thread_id='t'");
  await assert.rejects(()=>s.call('send_message',{threadId:'t',message:'Hello'}),/archived/);
});

test('loopback origin validation rejects egress, userinfo and URL tricks',()=>{
  assert.equal(localOrigin('http://127.0.0.1:3773'),'http://127.0.0.1:3773');
  for(const u of ['https://example.com','http://127.0.0.1.evil:3773','http://user:pass@127.0.0.1','http://127.0.0.1/a','http://127.0.0.1/?token=x'])assert.throws(()=>localOrigin(u));
});

test('separate SQLite connections serialize sends and release on close',t=>{
  const {dir}=fixture(t);const previous=process.env.T3_PRIME_STATE_DIR;process.env.T3_PRIME_STATE_DIR=dir;
  try {const release=acquireSendLock();assert.equal(typeof release.release,'function');assert.equal(acquireSendLock(),null);release.release();const again=acquireSendLock();assert.equal(typeof again.release,'function');again.release();}
  finally {if(previous===undefined)delete process.env.T3_PRIME_STATE_DIR;else process.env.T3_PRIME_STATE_DIR=previous;}
});


test('accepted requests wait through delayed projection and block concurrent starts',async t=>{
  const {store,db,dir}=fixture(t);const previous=process.env.T3_PRIME_STATE_DIR;process.env.T3_PRIME_STATE_DIR=dir;
  let count=0;
  const s=sender(store,idle,async cmd=>{
    count++;
    setTimeout(()=>{
      db.prepare('INSERT INTO projection_thread_messages VALUES(?,?,NULL,?,?,0,?)').run(cmd.message.messageId,'t','user',cmd.message.text,'05');
      db.prepare('INSERT INTO projection_turns VALUES(3,?,?,?,?,?)').run('t','turn-3',cmd.message.messageId,'completed','now');
      db.exec("INSERT INTO projection_thread_messages VALUES('reply-3','t','turn-3','assistant','Delayed correct reply',0,'06')");
    },50);
    return {sequence:99};
  },acquireSendLock);
  try {
    const sent=await s.call('send_message',{threadId:'t',message:'First'});
    const second=await s.call('send_message',{threadId:'t',message:'Must not overwrite'});
    assert.equal(second.outcome,'busy');assert.equal(count,1);
    const reply=await s.call('wait_for_turn',{threadId:'t',requestId:sent.requestId,timeoutSeconds:3});
    assert.equal(reply.outcome,'completed');assert.equal(reply.reply.messageId,'reply-3');
  } finally {if(previous===undefined)delete process.env.T3_PRIME_STATE_DIR;else process.env.T3_PRIME_STATE_DIR=previous;}
});

test('same request retries safely before projection without admitting another request',async t=>{
  const {store,dir}=fixture(t);const previous=process.env.T3_PRIME_STATE_DIR;process.env.T3_PRIME_STATE_DIR=dir;
  const ids=[];
  const s=sender(store,idle,async cmd=>{ids.push(cmd.commandId);return {sequence:99};},acquireSendLock);
  try {
    const a=await s.call('send_message',{threadId:'t',message:'Retry me'});
    const b=await s.call('send_message',{threadId:'t',message:'Retry me',requestId:a.requestId});
    assert.equal(b.accepted,true);assert.deepEqual(ids,[a.requestId,a.requestId]);
    const c=await s.call('send_message',{threadId:'t',message:'Another request'});
    assert.equal(c.outcome,'busy');assert.equal(ids.length,2);
  }finally {if(previous===undefined)delete process.env.T3_PRIME_STATE_DIR;else process.env.T3_PRIME_STATE_DIR=previous;}
});

test('failed dispatch reservation is discoverable and recoverable across service instances',async t=>{
  const {store,db,dir}=fixture(t);const previous=process.env.T3_PRIME_STATE_DIR;process.env.T3_PRIME_STATE_DIR=dir;
  const originalId='1eb8cbd3-b4db-4660-9703-3cc29741984b';
  try {
    const failing=sender(store,idle,async()=>{throw new Error('lost connection');},acquireSendLock);
    await assert.rejects(()=>failing.call('send_message',{threadId:'t',message:'Original',requestId:originalId}));
    const sent=[];
    const restarted=sender(store,idle,async cmd=>{sent.push(cmd.commandId);return {sequence:88};},acquireSendLock);
    const blocked=await restarted.call('send_message',{threadId:'t',message:'New request'});
    assert.equal(blocked.accepted,false);assert.equal(blocked.blockingRequestId,originalId);
    assert.equal(blocked.blockingRequestState,'unmapped');assert.match(blocked.note,/same.*text/);
    assert.equal(sent.length,0);
    await assert.rejects(()=>restarted.call('send_message',{threadId:'t',message:'Changed',requestId:blocked.blockingRequestId}),/another message/);
    assert.equal((await restarted.call('send_message',{threadId:'t',message:'Original',requestId:blocked.blockingRequestId})).accepted,true);
    assert.deepEqual(sent,[originalId]);
    db.prepare('INSERT INTO projection_thread_messages VALUES(?,?,NULL,?,?,0,?)').run(originalId,'t','user','Original','05');
    db.prepare('INSERT INTO projection_turns VALUES(3,?,?,?,?,?)').run('t','recovered-turn',originalId,'completed','now');
    assert.equal((await restarted.call('send_message',{threadId:'t',message:'New request'})).accepted,true);
  }finally {if(previous===undefined)delete process.env.T3_PRIME_STATE_DIR;else process.env.T3_PRIME_STATE_DIR=previous;}
});

test('completed turn never substitutes progress for a still-streaming final reply',async t=>{
  const {db,service}=fixture(t);
  db.exec("INSERT INTO projection_thread_messages VALUES('final','t','turn-1','assistant','Final answer',1,'05')");
  const pending=await service.call('wait_for_turn',{threadId:'t',requestId:'req-1',timeoutSeconds:0});
  assert.equal(pending.outcome,'completed');assert.equal(pending.reply,null);
  assert.equal(pending.replyState,'streaming');assert.equal(pending.pendingReplyMessageId,'final');
  db.exec("UPDATE projection_thread_messages SET is_streaming=0 WHERE message_id='final'");
  const ready=await service.call('wait_for_turn',{threadId:'t',requestId:'req-1',timeoutSeconds:0});
  assert.equal(ready.replyState,'ready');assert.equal(ready.reply.messageId,'final');
  db.exec("DELETE FROM projection_thread_messages WHERE turn_id='turn-1'");
  assert.equal((await service.call('wait_for_turn',{threadId:'t',requestId:'req-1',timeoutSeconds:0})).replyState,'missing');
});

test('grouped search counts filtered hits before paging threads and hydrates representative',async t=>{
  const {db,service}=fixture(t);
  db.exec(`INSERT INTO projection_threads(thread_id,project_id,title,updated_at) VALUES('t2','p','Second thread','today'),('t3','p','Archived thread','today');
    UPDATE projection_threads SET archived_at='today' WHERE thread_id='t3';
    INSERT INTO projection_thread_messages VALUES
    ('g1','t',NULL,'user','Needle first',0,'10'),('g2','t',NULL,'assistant','Needle second',0,'11'),
    ('g3','t',NULL,'assistant','Needle third',0,'12'),('g4','t',NULL,'assistant','Needle newest',0,'13'),
    ('g5','t2',NULL,'assistant','Needle other thread',0,'09'),('g6','t3',NULL,'assistant','Needle archived',0,'14');`);
  const grouped=await service.call('search_messages',{query:'needle',groupByThread:true,limit:3,snippetChars:160});
  assert.deepEqual(grouped.matches.map(m=>[m.threadId,m.hitCount,m.messageId,m.state]),[['t',4,'g4','interrupted'],['t2',1,'g5','idle']]);
  assert.equal(grouped.nextOffset,null);
  assert.ok(Buffer.byteLength(JSON.stringify(grouped))<1500);
  const context=await service.call('get_thread',{threadId:grouped.matches[0].threadId,centerMessageId:grouped.matches[0].messageId,limit:1});
  assert.equal(context.messages[0].text,'Needle newest');
  const page=await service.call('search_messages',{query:'needle',groupByThread:true,limit:1});
  const next=await service.call('search_messages',{query:'needle',groupByThread:true,limit:1,offset:page.nextOffset});
  assert.equal(next.matches[0].threadId,'t2');assert.equal(next.nextOffset,null);
  const scoped=await service.call('search_messages',{query:'needle',groupByThread:true,threadId:'t',role:'user'});
  assert.equal(scoped.matches[0].hitCount,1);assert.equal(scoped.matches[0].messageId,'g1');
  assert.equal((await service.call('search_messages',{query:'needle',groupByThread:true,projectId:'absent'})).matches.length,0);
  assert.equal((await service.call('search_messages',{query:'needle',groupByThread:true,includeArchived:true})).matches.length,3);
  const normal=await service.call('search_messages',{query:'needle',limit:3});
  assert.deepEqual(normal.matches.map(m=>m.threadId),['t','t','t']);assert.equal(normal.matches[0].hitCount,undefined);
});
test('thread discovery and reads expose model, checkout, and modes',async t=>{
 const {db,service}=fixture(t);
 db.exec("ALTER TABLE projection_threads ADD COLUMN model_selection_json TEXT; ALTER TABLE projection_threads ADD COLUMN worktree_path TEXT; ALTER TABLE projection_threads ADD COLUMN runtime_mode TEXT; ALTER TABLE projection_threads ADD COLUMN interaction_mode TEXT;");
 db.prepare('UPDATE projection_threads SET model_selection_json=?,branch=?,worktree_path=?,runtime_mode=?,interaction_mode=?').run('{"instanceId":"codex","model":"example"}','feature','/workspace/isolated','full-access','default');
 const list=await service.call('list_threads',{});
 assert.equal(list.threads[0].modelSelection.model,'example');assert.equal(list.threads[0].projectPath,'/workspace');assert.equal(list.threads[0].worktreePath,'/workspace/isolated');assert.equal(list.threads[0].runtimeMode,'full-access');
 const read=await service.call('get_thread',{threadId:'t'});assert.equal(read.thread.branch,'feature');
});
