import { randomUUID } from 'node:crypto';
import { retryRead } from './retry.mjs';
import { freeSlots, parseTarget, isAdmin, confirmedOutcome } from './policy.mjs';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
export class Engine {
  busy=false; stopped=false;
  constructor(db,wa,log,wait=delay){this.db=db;this.wa=wa;this.log=log;this.wait=wait;}
  async create(groupId,kind,amount) {
    const c=await this.db.connect();
    try {
      await c.query('BEGIN');
      const {rows:[group]}=await c.query('SELECT * FROM groups WHERE id=$1 FOR UPDATE',[groupId]);
      if(!group?.is_admin)throw new Error('Choose a group where the connected account is an admin');
      const {rows:[active]}=await c.query(`SELECT id FROM jobs WHERE group_id=$1 AND status IN ('queued','running','paused')`,[groupId]);
      if(active)throw new Error('This group already has an active or paused job');
      const {rows:requests}=await c.query(`SELECT jid FROM requests WHERE group_id=$1 AND status='pending' AND ($2::boolean=false OR first_seen>$3) ORDER BY first_seen,jid`,[groupId,kind==='auto',group.auto_since]);
      const target=parseTarget(kind,amount,requests.length);
      if(!target)throw new Error('No eligible pending requests');
      const id=randomUUID();
      await c.query('INSERT INTO jobs(id,group_id,kind,target) VALUES($1,$2,$3,$4)',[id,groupId,kind,target]);
      for(let i=0;i<requests.length;i++)await c.query('INSERT INTO job_items(job_id,jid,ordinal) VALUES($1,$2,$3)',[id,requests[i].jid,i]);
      await c.query('COMMIT');
      await this.log('info','job.created',groupId,id,`${kind} job queued. Target: ${target}.`);
      return id;
    } catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  async pause(job,reason){await this.db.query("UPDATE jobs SET status='paused',reason=$2,updated_at=now() WHERE id=$1 AND status IN ('running','queued')",[job.id,reason]);await this.log('warn','job.paused',job.group_id,job.id,reason);}
  async tick(){
    if(this.busy||this.stopped||this.wa.state!=='connected')return;
    this.busy=true;
    try {
      const {rows:[job]}=await this.db.query("UPDATE jobs SET status='running',updated_at=now() WHERE id=(SELECT id FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1) RETURNING *");
      if(job) await this.run(job);
      else {
        const {rows:groups}=await this.db.query(`SELECT g.* FROM groups g WHERE auto_enabled AND is_admin AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.group_id=g.id AND j.status IN ('queued','running','paused')) AND EXISTS(SELECT 1 FROM requests r WHERE r.group_id=g.id AND r.status='pending' AND r.first_seen>g.auto_since)`);
        for(const g of groups)await this.create(g.id,'auto').catch(e=>this.log('warn','auto.waiting',g.id,null,e.message));
      }
    }catch(e){await this.log('error','worker.error',null,null,e.message);}finally{this.busy=false;}
  }
  async run(job){
    try {
      while(!this.stopped){
        const {rows:[current]}=await this.db.query('SELECT * FROM jobs WHERE id=$1',[job.id]);
        if(current.status!=='running')return;
        if(current.confirmed>=current.target){await this.db.query("UPDATE jobs SET status='completed',reason=null,updated_at=now() WHERE id=$1",[job.id]);await this.log('info','job.completed',job.group_id,job.id,`${current.confirmed} approvals confirmed`);return;}
        if(this.wa.state!=='connected'){await this.db.query("UPDATE jobs SET status='queued',reason='Waiting for WhatsApp reconnect' WHERE id=$1 AND status='running'",[job.id]);return;}
        const meta=await this.wa.syncGroup(job.group_id);
        if(!isAdmin(meta,this.wa.ownIds))return this.pause(job,'Admin permission lost');
        const {rows:[group]}=await this.db.query('SELECT * FROM groups WHERE id=$1',[job.group_id]);
        if(!freeSlots(meta,group.capacity))return this.pause(job,'Group capacity reached. Remaining requests are untouched.');
        const {rows:[item]}=await this.db.query(`SELECT i.* FROM job_items i JOIN requests r ON r.group_id=$2 AND r.jid=i.jid WHERE i.job_id=$1 AND i.status='pending' AND r.status='pending' ORDER BY i.ordinal LIMIT 1`,[job.id,job.group_id]);
        if(!item)return this.pause(job,'Eligible requests exhausted before the target was reached. Review requests removed by other admins.');
        // The in-flight marker is durable before any external effect.
        const dispatch=await this.db.connect();
        try{await dispatch.query('BEGIN');await dispatch.query("UPDATE job_items SET status='sending',attempts=attempts+1 WHERE job_id=$1 AND jid=$2",[job.id,item.jid]);await dispatch.query("UPDATE requests SET status='processing' WHERE group_id=$1 AND jid=$2",[job.group_id,item.jid]);await dispatch.query('COMMIT');}catch(e){await dispatch.query('ROLLBACK');throw e;}finally{dispatch.release();}
        let response;
        try{response=await this.wa.require().groupRequestParticipantsUpdate(job.group_id,[item.jid],'approve');}
        catch(e){await this.db.query("UPDATE job_items SET status='uncertain' WHERE job_id=$1 AND jid=$2",[job.id,item.jid]);return this.pause(job,'WhatsApp response was interrupted. Outcome is uncertain; automatic retry is blocked to protect the exact target.');}
        let verified;
        try{verified=await retryRead(()=>this.wa.require().groupMetadata(job.group_id));
          for(let n=0;n<2&&confirmedOutcome(response,item.jid,verified)==='uncertain';n++){await this.wait(1000*(n+1));verified=await retryRead(()=>this.wa.require().groupMetadata(job.group_id));}}
        catch(e){return this.pause(job,'Approval sent but membership verification failed. Review the uncertain result before continuing.');}
        const outcome=confirmedOutcome(response,item.jid,verified);
        if(outcome==='confirmed'){
          const c=await this.db.connect();
          try{await c.query('BEGIN');await c.query("UPDATE job_items SET status='confirmed' WHERE job_id=$1 AND jid=$2",[job.id,item.jid]);await c.query("UPDATE requests SET status='approved' WHERE group_id=$1 AND jid=$2",[job.group_id,item.jid]);await c.query('UPDATE jobs SET confirmed=confirmed+1,updated_at=now() WHERE id=$1',[job.id]);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
          await this.log('info','approval.confirmed',job.group_id,job.id,'WhatsApp accepted the approval and membership was verified.');
        } else if(outcome==='rejected'){
          await this.db.query("UPDATE job_items SET status='failed' WHERE job_id=$1 AND jid=$2",[job.id,item.jid]);
          await this.db.query("UPDATE requests SET status='pending' WHERE group_id=$1 AND jid=$2",[job.group_id,item.jid]);
          await this.log('warn','approval.failed',job.group_id,job.id,`WhatsApp declined an approval (${response?.[0]?.status}). It was not counted.`);
        } else {
          await this.db.query("UPDATE job_items SET status='uncertain' WHERE job_id=$1 AND jid=$2",[job.id,item.jid]);
          return this.pause(job,'WhatsApp did not provide a verifiable approval. Review the uncertain result before continuing.');
        }
        await this.wait(Math.max(1500,Number(process.env.APPROVAL_DELAY_MS)||2500));
      }
    }catch(e){await this.pause(job,e.message);}
  }
  async recover(){
    await this.db.query("UPDATE job_items SET status='uncertain' WHERE status='sending'");
    await this.db.query("UPDATE requests SET status='uncertain' WHERE status='processing'");
    await this.db.query("UPDATE jobs SET status='paused',reason='Interrupted while an approval was in flight. Manual outcome review required.' WHERE status IN ('running','queued') AND EXISTS(SELECT 1 FROM job_items WHERE job_id=jobs.id AND status='uncertain')");
    await this.db.query("UPDATE jobs SET status='queued',reason='Resuming after service restart' WHERE status='running'");
  }
}
