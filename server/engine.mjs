import { randomUUID } from 'node:crypto';
import { retryRead } from './retry.mjs';
import { freeSlots, parseTarget, isAdmin, confirmedOutcome } from './policy.mjs';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
export class Engine {
  busy=false; stopped=false;
  constructor(db,wa,log,wait=delay,options={}){this.db=db;this.wa=wa;this.log=log;this.wait=wait;this.batchSize=Math.max(1,Math.min(20,Math.floor(Number(options.batchSize??process.env.APPROVAL_BATCH_SIZE)||10)));this.batchDelay=Math.max(0,Math.min(60000,Number(options.batchDelay??process.env.APPROVAL_BATCH_DELAY_MS??250) || 0));}
  async create(groupId,kind,amount) {
    const c=await this.db.connect();
    let id,target;
    try {
      await c.query('BEGIN');
      const {rows:[group]}=await c.query('SELECT * FROM groups WHERE id=$1 FOR UPDATE',[groupId]);
      if(!group?.is_admin)throw new Error('Choose a group where the connected account is an admin');
      const {rows:[active]}=await c.query(`SELECT id FROM jobs WHERE group_id=$1 AND status IN ('queued','running','paused')`,[groupId]);
      if(active)throw new Error('This group already has an active or paused job');
      const {rows:requests}=await c.query(`SELECT jid FROM requests WHERE group_id=$1 AND status='pending' AND ($2::boolean=false OR first_seen>$3) ORDER BY first_seen,jid`,[groupId,kind==='auto',group.auto_since]);
      target=parseTarget(kind,amount,requests.length);
      if(!target)throw new Error('No eligible pending requests');
      id=randomUUID();
      await c.query('INSERT INTO jobs(id,group_id,kind,target) VALUES($1,$2,$3,$4)',[id,groupId,kind,target]);
      await c.query('INSERT INTO job_items(job_id,jid,ordinal) SELECT $1,jid,(n-1)::int FROM unnest($2::text[]) WITH ORDINALITY AS snapshot(jid,n)',[id,requests.map(r=>r.jid)]);
      await c.query('COMMIT');
    } catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
    await this.log('info','job.created',groupId,id,`${kind} job queued. Target: ${target}.`);
    return id;
  }
  async pause(job,reason){await this.db.query("UPDATE jobs SET status='paused',reason=$2,updated_at=now() WHERE id=$1 AND status IN ('running','queued')",[job.id,reason]);await this.log('warn','job.paused',job.group_id,job.id,reason);}
  async tick(){
    if(this.busy||this.stopped||this.wa.state!=='connected')return;
    this.busy=true;
    try {
      const claim=async()=>{const {rows:[job]}=await this.db.query("UPDATE jobs SET status='running',updated_at=now() WHERE id=(SELECT id FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1) RETURNING *");return job;};
      let job=await claim();
      if(!job) {
        const {rows:groups}=await this.db.query(`SELECT g.* FROM groups g WHERE auto_enabled AND is_admin AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.group_id=g.id AND j.status IN ('queued','running','paused')) AND EXISTS(SELECT 1 FROM requests r WHERE r.group_id=g.id AND r.status='pending' AND r.first_seen>g.auto_since)`);
        for(const g of groups)await this.create(g.id,'auto').catch(e=>this.log('warn','auto.waiting',g.id,null,e.message));
        job=await claim();
      }
      if(job)await this.run(job);
    }catch(e){await this.log('error','worker.error',null,null,e.message);}finally{this.busy=false;}
  }
  async metadata(groupId){
    return this.wa.readMetadata?this.wa.readMetadata(groupId):retryRead(()=>this.wa.require().groupMetadata(groupId));
  }
  async run(job){
    try {
      while(!this.stopped){
        const {rows:[current]}=await this.db.query('SELECT * FROM jobs WHERE id=$1',[job.id]);
        if(current.status!=='running')return;
        if(current.confirmed>=current.target){
          await this.db.query("UPDATE jobs SET status='completed',reason=null,updated_at=now() WHERE id=$1",[job.id]);
          await this.log('info','job.completed',job.group_id,job.id,`${current.confirmed} approvals confirmed`);return;
        }
        if(this.wa.state!=='connected'){
          await this.db.query("UPDATE jobs SET status='queued',reason='Waiting for WhatsApp reconnect' WHERE id=$1 AND status='running'",[job.id]);return;
        }
        // Refresh only metadata here. Full pending snapshots are synced at job
        // creation/resume and in background reconciliation, not for every person.
        const meta=await this.metadata(job.group_id);
        if(!isAdmin(meta,this.wa.ownIds))return this.pause(job,'Admin permission lost');
        const c=await this.db.connect();let items=[],reason=null,halt=false;
        try{
          await c.query('BEGIN');
          const {rows:[locked]}=await c.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE',[job.id]);
          const {rows:[group]}=await c.query('SELECT * FROM groups WHERE id=$1',[job.group_id]);
          if(locked.status!=='running'||this.stopped)halt=true;
          else{
            const budget=Math.min(this.batchSize,locked.target-locked.confirmed,freeSlots(meta,group.capacity));
            if(budget<=0)reason='Group capacity reached. Remaining requests are untouched.';
            else{
              const result=await c.query(`SELECT i.* FROM job_items i JOIN requests r ON r.group_id=$2 AND r.jid=i.jid WHERE i.job_id=$1 AND i.status='pending' AND r.status='pending' ORDER BY i.ordinal LIMIT $3`,[job.id,job.group_id,budget]);
              items=result.rows;
              if(!items.length)reason='Eligible requests exhausted before the target was reached. Review requests removed by other admins.';
              else{
                const ids=items.map(i=>i.jid);
                await c.query("UPDATE job_items SET status='sending',attempts=attempts+1 WHERE job_id=$1 AND jid=ANY($2::text[])",[job.id,ids]);
                await c.query("UPDATE requests SET status='processing' WHERE group_id=$1 AND jid=ANY($2::text[])",[job.group_id,ids]);
              }
            }
          }
          await c.query('COMMIT');
        }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
        if(halt)return;
        if(reason)return this.pause(job,reason);
        const ids=items.map(i=>i.jid);let response;
        try{response=await this.wa.require().groupRequestParticipantsUpdate(job.group_id,ids,'approve');}
        catch(e){await this.record(job,ids,[],[],ids);return this.pause(job,'A batch response was interrupted. Uncertain results require review; they will not be retried automatically.');}
        let verified;
        try{
          verified=await this.metadata(job.group_id);
          for(let n=0;n<2&&ids.some(jid=>confirmedOutcome(response,jid,verified)==='uncertain');n++){
            await this.wait(1000*(n+1));verified=await this.metadata(job.group_id);
          }
        }catch(e){await this.record(job,ids,[],[],ids);return this.pause(job,'Batch sent but membership verification failed. Review the uncertain results before continuing.');}
        const confirmed=[],rejected=[],uncertain=[];
        for(const jid of ids){const result=confirmedOutcome(response,jid,verified);(result==='confirmed'?confirmed:result==='rejected'?rejected:uncertain).push(jid);}
        await this.record(job,ids,confirmed,rejected,uncertain);
        await this.log(uncertain.length||rejected.length?'warn':'info','approval.batch',job.group_id,job.id,`Batch: ${confirmed.length} confirmed, ${rejected.length} declined, ${uncertain.length} uncertain. Each confirmed member was verified.`);
        if(uncertain.length)return this.pause(job,'Some batch outcomes could not be verified. Confirmed approvals were counted; uncertain results require review.');
        // Reuse this verified membership only to update the displayed count;
        // the next dispatch still fetches fresh metadata and rechecks capacity.
        await this.db.query('UPDATE groups SET member_count=$2 WHERE id=$1',[job.group_id,verified.size??verified.participants.length]);
        if(this.batchDelay)await this.wait(this.batchDelay);
      }
    }catch(e){await this.pause(job,e.message);}
  }
  async record(job,ids,confirmed,rejected,uncertain){
    const outcomes=[...confirmed,...rejected,...uncertain];
    if(outcomes.length!==ids.length||new Set(outcomes).size!==ids.length||outcomes.some(jid=>!ids.includes(jid)))throw new Error('Invalid batch outcome accounting');
    const c=await this.db.connect();
    try{
      await c.query('BEGIN');
      const results=await c.query("UPDATE job_items SET status='confirmed' WHERE job_id=$1 AND jid=ANY($2::text[]) AND status='sending' RETURNING jid",[job.id,confirmed]);
      const credited=results.rows.map(r=>r.jid);
      await c.query("UPDATE job_items SET status='failed' WHERE job_id=$1 AND jid=ANY($2::text[]) AND status='sending'",[job.id,rejected]);
      await c.query("UPDATE job_items SET status='uncertain' WHERE job_id=$1 AND jid=ANY($2::text[]) AND status='sending'",[job.id,uncertain]);
      await c.query("UPDATE requests SET status='approved' WHERE group_id=$1 AND jid=ANY($2::text[])",[job.group_id,credited]);
      await c.query("UPDATE requests SET status='pending' WHERE group_id=$1 AND jid=ANY($2::text[]) AND status='processing'",[job.group_id,rejected]);
      await c.query("UPDATE requests SET status='uncertain' WHERE group_id=$1 AND jid=ANY($2::text[]) AND status='processing'",[job.group_id,uncertain]);
      if(credited.length){
        const updated=await c.query('UPDATE jobs SET confirmed=confirmed+$2,updated_at=now() WHERE id=$1 AND confirmed+$2<=target RETURNING id',[job.id,credited.length]);
        if(!updated.rows.length)throw new Error('Approval target invariant failed; review the batch');
      }
      await c.query('COMMIT');
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  async recover(){
    await this.db.query("UPDATE job_items SET status='uncertain' WHERE status='sending'");
    await this.db.query("UPDATE requests SET status='uncertain' WHERE status='processing'");
    await this.db.query("UPDATE jobs SET status='paused',reason='Interrupted while an approval was in flight. Manual outcome review required.' WHERE status IN ('running','queued') AND EXISTS(SELECT 1 FROM job_items WHERE job_id=jobs.id AND status='uncertain')");
    await this.db.query("UPDATE jobs SET status='queued',reason='Resuming after service restart' WHERE status='running'");
  }
}
