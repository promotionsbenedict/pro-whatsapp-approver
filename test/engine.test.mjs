import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { Engine } from '../server/engine.mjs';
import { freeSlots, parseTarget, confirmedOutcome } from '../server/policy.mjs';
async function fixture(t,{count=5,members=10,behavior='success',batchSize=10}={}){
  const pg=new PGlite();await pg.exec(await readFile(new URL('../server/schema.sql',import.meta.url),'utf8'));
  const db={query:(sql,args)=>pg.query(sql,args),connect:async()=>({query:(sql,args)=>pg.query(sql,args),release(){}})};
  t.after(()=>pg.close());
  await db.query("INSERT INTO groups(id,name,member_count,is_admin,baseline_at) VALUES('g','Test group',$1,true,now())",[members]);
  for(let i=0;i<count;i++)await db.query("INSERT INTO requests(group_id,jid) VALUES('g',$1)",[`p${i}`]);
  const meta={id:'g',size:members,participants:[{id:'owner',admin:'admin'}]};let sends=0,metadataReads=0,syncs=0;const batches=[];
  const socket={groupMetadata:async()=>{metadataReads++;return structuredClone(meta);},groupRequestParticipantsUpdate:async(g,ids)=>{
    batches.push([...ids]);const response=[];
    for(const jid of ids){
      sends++;
      if(behavior==='denied'&&sends===1){response.push({jid,status:'403'});continue;}
      meta.participants.push({id:jid});meta.size++;
      if(behavior==='timeout')throw new Error('Connection dropped after remote approval');
      response.push({jid,status:'200'});
    }
    return response;
  }};
  const wa={state:'connected',ownIds:['owner'],syncGroup:async()=>{syncs++;return structuredClone(meta);},require:()=>socket};
  const engine=new Engine(db,wa,async()=>{},async()=>{},{batchSize,batchDelay:0});
  const job=async id=>(await db.query('SELECT * FROM jobs WHERE id=$1',[id])).rows[0];
  return {db,engine,wa,meta,job,socket,batches,sends:()=>sends,metadataReads:()=>metadataReads,syncs:()=>syncs};
}
test('capacity is bounded and invalid counts fail closed',()=>{assert.equal(freeSlots({size:1023},2000),1);assert.equal(freeSlots({size:11},10),0);assert.throws(()=>freeSlots({}));});
test('target validation rejects fractional, excessive and invalid modes',()=>{for(const n of [0,-1,1.5,NaN,100001])assert.throws(()=>parseTarget('custom',n,200000));assert.throws(()=>parseTarget('custom',3,2));assert.throws(()=>parseTarget('invalid',1,1));assert.equal(parseTarget('all',0,8),8);});
test('success requires both WhatsApp acceptance and membership',()=>{assert.equal(confirmedOutcome([{jid:'a',status:'200'}],'a',{participants:[]}), 'uncertain');assert.equal(confirmedOutcome([{jid:'a',status:'200'}],'a',{participants:[{id:'a'}]}),'confirmed');assert.equal(confirmedOutcome([{jid:'a',status:'403'}],'a',{participants:[]}), 'rejected');});
test('exact target approves only two and leaves excess pending',async t=>{const f=await fixture(t);const id=await f.engine.create('g','custom',2);await f.engine.tick();assert.equal(f.sends(),2);assert.equal((await f.job(id)).status,'completed');assert.equal((await f.job(id)).confirmed,2);assert.equal((await f.db.query("SELECT count(*)::int n FROM requests WHERE status='pending'")).rows[0].n,3);});
test('capacity bounds each batch even when only one slot remains',async t=>{const f=await fixture(t,{members:1023});const id=await f.engine.create('g','custom',2);await f.engine.tick();assert.equal(f.sends(),1);const j=await f.job(id);assert.equal(j.confirmed,1);assert.equal(j.status,'paused');assert.match(j.reason,/capacity/);});
test('ambiguous timeout is not retried or reported as success',async t=>{const f=await fixture(t,{behavior:'timeout'});const id=await f.engine.create('g','custom',2);await f.engine.tick();await f.engine.tick();assert.equal(f.sends(),1);assert.equal((await f.job(id)).confirmed,0);assert.equal((await f.job(id)).status,'paused');await f.db.query("UPDATE jobs SET status='cancelled' WHERE id=$1",[id]);const next=await f.engine.create('g','all');assert.equal((await f.job(next)).target,3);});
test('failed response does not count toward exact target',async t=>{const f=await fixture(t,{behavior:'denied'});const id=await f.engine.create('g','custom',2);await f.engine.tick();assert.equal(f.sends(),3);assert.equal((await f.job(id)).confirmed,2);assert.equal((await f.job(id)).status,'completed');assert.equal((await f.db.query("SELECT count(*)::int n FROM job_items WHERE status='failed'")).rows[0].n,1);});
test('a group cannot have overlapping active jobs',async t=>{const f=await fixture(t);await f.engine.create('g','custom',1);await assert.rejects(f.engine.create('g','all'),/already has an active/);});
test('crash recovery quarantines an in-flight approval',async t=>{const f=await fixture(t);const id=await f.engine.create('g','custom',2);await f.db.query("UPDATE jobs SET status='running' WHERE id=$1",[id]);await f.db.query("UPDATE job_items SET status='sending' WHERE job_id=$1 AND jid='p0'",[id]);await f.db.query("UPDATE requests SET status='processing' WHERE jid='p0'");await f.engine.recover();assert.equal((await f.job(id)).status,'paused');assert.equal((await f.job(id)).confirmed,0);assert.equal((await f.db.query("SELECT status FROM requests WHERE jid='p0'")).rows[0].status,'uncertain');assert.equal(f.sends(),0);});
test('automatic jobs exclude historical queue before activation',async t=>{const f=await fixture(t);await f.db.query("UPDATE groups SET auto_enabled=true,auto_since=now()-interval '1 hour' WHERE id='g'");await f.db.query("UPDATE requests SET first_seen=now()-interval '2 hours' WHERE jid<>'p4'");const id=await f.engine.create('g','auto');assert.equal((await f.job(id)).target,1);await f.engine.tick();assert.equal(f.sends(),1);assert.equal((await f.job(id)).confirmed,1);});
test('disconnected worker leaves queued jobs untouched',async t=>{const f=await fixture(t);const id=await f.engine.create('g','all');f.wa.state='disconnected';await f.engine.tick();assert.equal((await f.job(id)).status,'queued');assert.equal(f.sends(),0);});
test('loss of admin permission pauses without sending',async t=>{const f=await fixture(t);const id=await f.engine.create('g','custom',1);f.meta.participants[0].admin=null;await f.engine.tick();assert.equal((await f.job(id)).status,'paused');assert.equal(f.sends(),0);});
test('LID and phone-number aliases verify the same member',()=>{const result=[{jid:'123@s.whatsapp.net',status:'200'}];assert.equal(confirmedOutcome(result,'123@s.whatsapp.net',{participants:[{id:'456@lid',phoneNumber:'123@s.whatsapp.net'}]}),'confirmed');});
test('safe read retries are bounded and permission failures stop immediately',async()=>{const {retryRead}=await import('../server/retry.mjs');let calls=0;assert.equal(await retryRead(async()=>{if(++calls<3)throw new Error('temporary');return 42;},async()=>{}),42);assert.equal(calls,3);calls=0;await assert.rejects(retryRead(async()=>{calls++;const e=new Error('forbidden');e.output={statusCode:403};throw e;},async()=>{}));assert.equal(calls,1);});
test('75 approvals use eight bounded writes and 16 metadata reads, with no repeated pending sync',async t=>{
 const f=await fixture(t,{count:100});const id=await f.engine.create('g','custom',75);await f.engine.tick();
 assert.equal((await f.job(id)).status,'completed');assert.equal((await f.job(id)).confirmed,75);
 assert.equal(f.batches.length,8);assert.deepEqual(f.batches.map(b=>b.length),[10,10,10,10,10,10,10,5]);
 assert.equal(f.metadataReads(),16);assert.equal(f.syncs(),0);assert.equal(f.sends(),75);
 assert.equal((await f.db.query("SELECT count(*)::int n FROM requests WHERE status='pending'")).rows[0].n,25);
});
test('capacity changes by another admin stop the next batch',async t=>{
 const f=await fixture(t,{count:30,members:1000});const read=f.socket.groupMetadata;let reads=0;
 f.socket.groupMetadata=async()=>{if(++reads===3)f.meta.size=1024;return read();};
 const id=await f.engine.create('g','custom',20);await f.engine.tick();assert.equal(f.sends(),10);assert.equal((await f.job(id)).status,'paused');assert.equal((await f.job(id)).confirmed,10);
});
test('mixed batch results count only verified successes and pause unknown outcomes',async t=>{
 const f=await fixture(t,{batchSize:3});f.socket.groupRequestParticipantsUpdate=async(g,ids)=>{f.batches.push([...ids]);f.meta.participants.push({id:ids[0]});f.meta.size++;return [{jid:ids[0],status:'200'},{jid:ids[1],status:'403'}];};
 const id=await f.engine.create('g','custom',3);await f.engine.tick();assert.equal((await f.job(id)).confirmed,1);assert.equal((await f.job(id)).status,'paused');
 const statuses=(await f.db.query('SELECT status,count(*)::int n FROM job_items WHERE job_id=$1 GROUP BY status',[id])).rows;
 assert.equal(statuses.find(r=>r.status==='confirmed').n,1);assert.equal(statuses.find(r=>r.status==='failed').n,1);assert.equal(statuses.find(r=>r.status==='uncertain').n,1);
 await f.engine.tick();assert.equal(f.batches.length,1);
});
test('pause during a batch allows that batch to finish and dispatches nothing else',async t=>{
 const f=await fixture(t,{count:30});const id=await f.engine.create('g','custom',25),send=f.socket.groupRequestParticipantsUpdate;
 f.socket.groupRequestParticipantsUpdate=async(...args)=>{const result=await send(...args);await f.db.query("UPDATE jobs SET status='paused' WHERE id=$1",[id]);return result;};
 await f.engine.tick();assert.equal(f.batches.length,1);assert.equal((await f.job(id)).confirmed,10);assert.equal((await f.job(id)).status,'paused');
});
test('recording a batch twice cannot double-credit approvals',async t=>{
 const f=await fixture(t);const id=await f.engine.create('g','custom',2);await f.engine.tick();const job=await f.job(id),ids=f.batches[0];
 await f.engine.record(job,ids,ids,[],[]);assert.equal((await f.job(id)).confirmed,2);
});
test('success responses without visible membership leave the whole batch uncertain',async t=>{
 const f=await fixture(t);f.socket.groupRequestParticipantsUpdate=async(g,ids)=>{f.batches.push([...ids]);return ids.map(jid=>({jid,status:'200'}));};
 const id=await f.engine.create('g','custom',2);await f.engine.tick();assert.equal((await f.job(id)).confirmed,0);assert.equal((await f.job(id)).status,'paused');assert.equal(f.batches.length,1);
});
test('a pause while metadata is loading prevents any dispatch',async t=>{
 const f=await fixture(t);const id=await f.engine.create('g','custom',2),read=f.socket.groupMetadata;
 f.socket.groupMetadata=async()=>{await f.db.query("UPDATE jobs SET status='paused' WHERE id=$1",[id]);return read();};
 await f.engine.tick();assert.equal(f.batches.length,0);assert.equal((await f.job(id)).confirmed,0);
});
test('new automatic requests are queued and processed in the same worker tick',async t=>{
 const f=await fixture(t);await f.db.query("UPDATE groups SET auto_enabled=true,auto_since=now()-interval '1 hour' WHERE id='g'");
 await f.engine.tick();const {rows:[job]}=await f.db.query('SELECT * FROM jobs');assert.equal(job.kind,'auto');assert.equal(job.status,'completed');assert.equal(job.confirmed,5);assert.equal(f.batches.length,1);
});
