import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { Engine } from '../server/engine.mjs';
import { freeSlots, parseTarget, confirmedOutcome } from '../server/policy.mjs';
async function fixture(t,{count=5,members=10,behavior='success'}={}){
  const pg=new PGlite();await pg.exec(await readFile(new URL('../server/schema.sql',import.meta.url),'utf8'));
  const db={query:(sql,args)=>pg.query(sql,args),connect:async()=>({query:(sql,args)=>pg.query(sql,args),release(){}})};
  t.after(()=>pg.close());
  await db.query("INSERT INTO groups(id,name,member_count,is_admin,baseline_at) VALUES('g','Test group',$1,true,now())",[members]);
  for(let i=0;i<count;i++)await db.query("INSERT INTO requests(group_id,jid) VALUES('g',$1)",[`p${i}`]);
  const meta={id:'g',size:members,participants:[{id:'owner',admin:'admin'}]};let sends=0;
  const socket={groupMetadata:async()=>structuredClone(meta),groupRequestParticipantsUpdate:async(g,[jid])=>{
    sends++;
    if(behavior==='denied'&&sends===1)return [{jid,status:'403'}];
    meta.participants.push({id:jid});meta.size++;
    if(behavior==='timeout')throw new Error('Connection dropped after remote approval');
    return [{jid,status:'200'}];
  }};
  const wa={state:'connected',ownIds:['owner'],syncGroup:async()=>structuredClone(meta),require:()=>socket};
  const engine=new Engine(db,wa,async()=>{},async()=>{});
  const job=async id=>(await db.query('SELECT * FROM jobs WHERE id=$1',[id])).rows[0];
  return {db,engine,wa,meta,job,sends:()=>sends};
}
test('capacity is bounded and invalid counts fail closed',()=>{assert.equal(freeSlots({size:1023},2000),1);assert.equal(freeSlots({size:11},10),0);assert.throws(()=>freeSlots({}));});
test('target validation rejects fractional, excessive and invalid modes',()=>{for(const n of [0,-1,1.5,NaN,100001])assert.throws(()=>parseTarget('custom',n,200000));assert.throws(()=>parseTarget('custom',3,2));assert.throws(()=>parseTarget('invalid',1,1));assert.equal(parseTarget('all',0,8),8);});
test('success requires both WhatsApp acceptance and membership',()=>{assert.equal(confirmedOutcome([{jid:'a',status:'200'}],'a',{participants:[]}), 'uncertain');assert.equal(confirmedOutcome([{jid:'a',status:'200'}],'a',{participants:[{id:'a'}]}),'confirmed');assert.equal(confirmedOutcome([{jid:'a',status:'403'}],'a',{participants:[]}), 'rejected');});
test('exact target approves only two and leaves excess pending',async t=>{const f=await fixture(t);const id=await f.engine.create('g','custom',2);await f.engine.tick();assert.equal(f.sends(),2);assert.equal((await f.job(id)).status,'completed');assert.equal((await f.job(id)).confirmed,2);assert.equal((await f.db.query("SELECT count(*)::int n FROM requests WHERE status='pending'")).rows[0].n,3);});
test('capacity is rechecked between every approval',async t=>{const f=await fixture(t,{members:1023});const id=await f.engine.create('g','custom',2);await f.engine.tick();assert.equal(f.sends(),1);const j=await f.job(id);assert.equal(j.confirmed,1);assert.equal(j.status,'paused');assert.match(j.reason,/capacity/);});
test('ambiguous timeout is not retried or reported as success',async t=>{const f=await fixture(t,{behavior:'timeout'});const id=await f.engine.create('g','custom',2);await f.engine.tick();await f.engine.tick();assert.equal(f.sends(),1);assert.equal((await f.job(id)).confirmed,0);assert.equal((await f.job(id)).status,'paused');await f.db.query("UPDATE jobs SET status='cancelled' WHERE id=$1",[id]);const next=await f.engine.create('g','all');assert.equal((await f.job(next)).target,4);});
test('failed response does not count toward exact target',async t=>{const f=await fixture(t,{behavior:'denied'});const id=await f.engine.create('g','custom',2);await f.engine.tick();assert.equal(f.sends(),3);assert.equal((await f.job(id)).confirmed,2);assert.equal((await f.job(id)).status,'completed');assert.equal((await f.db.query("SELECT count(*)::int n FROM job_items WHERE status='failed'")).rows[0].n,1);});
test('a group cannot have overlapping active jobs',async t=>{const f=await fixture(t);await f.engine.create('g','custom',1);await assert.rejects(f.engine.create('g','all'),/already has an active/);});
test('crash recovery quarantines an in-flight approval',async t=>{const f=await fixture(t);const id=await f.engine.create('g','custom',2);await f.db.query("UPDATE jobs SET status='running' WHERE id=$1",[id]);await f.db.query("UPDATE job_items SET status='sending' WHERE job_id=$1 AND jid='p0'",[id]);await f.db.query("UPDATE requests SET status='processing' WHERE jid='p0'");await f.engine.recover();assert.equal((await f.job(id)).status,'paused');assert.equal((await f.job(id)).confirmed,0);assert.equal((await f.db.query("SELECT status FROM requests WHERE jid='p0'")).rows[0].status,'uncertain');assert.equal(f.sends(),0);});
test('automatic jobs exclude historical queue before activation',async t=>{const f=await fixture(t);await f.db.query("UPDATE groups SET auto_enabled=true,auto_since=now()-interval '1 hour' WHERE id='g'");await f.db.query("UPDATE requests SET first_seen=now()-interval '2 hours' WHERE jid<>'p4'");const id=await f.engine.create('g','auto');assert.equal((await f.job(id)).target,1);await f.engine.tick();assert.equal(f.sends(),1);assert.equal((await f.job(id)).confirmed,1);});
test('disconnected worker leaves queued jobs untouched',async t=>{const f=await fixture(t);const id=await f.engine.create('g','all');f.wa.state='disconnected';await f.engine.tick();assert.equal((await f.job(id)).status,'queued');assert.equal(f.sends(),0);});
test('loss of admin permission pauses without sending',async t=>{const f=await fixture(t);const id=await f.engine.create('g','custom',1);f.meta.participants[0].admin=null;await f.engine.tick();assert.equal((await f.job(id)).status,'paused');assert.equal(f.sends(),0);});
test('LID and phone-number aliases verify the same member',()=>{const result=[{jid:'123@s.whatsapp.net',status:'200'}];assert.equal(confirmedOutcome(result,'123@s.whatsapp.net',{participants:[{id:'456@lid',phoneNumber:'123@s.whatsapp.net'}]}),'confirmed');});
test('safe read retries are bounded and permission failures stop immediately',async()=>{const {retryRead}=await import('../server/retry.mjs');let calls=0;assert.equal(await retryRead(async()=>{if(++calls<3)throw new Error('temporary');return 42;},async()=>{}),42);assert.equal(calls,3);calls=0;await assert.rejects(retryRead(async()=>{calls++;const e=new Error('forbidden');e.output={statusCode:403};throw e;},async()=>{}));assert.equal(calls,1);});
