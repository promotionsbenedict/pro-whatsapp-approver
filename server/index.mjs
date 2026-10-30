import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import pg from 'pg';
import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { WhatsApp } from './whatsapp.mjs';
import { Engine } from './engine.mjs';
import { participantMatches } from './policy.mjs';
process.umask(0o077);
const key=process.env.ADMIN_API_KEY;
if(!key||key.length<32)throw new Error('Set ADMIN_API_KEY to a random secret of at least 32 characters');
if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL is required');
const db=new pg.Pool({connectionString:process.env.DATABASE_URL,max:8});
await db.query(await readFile(new URL('./schema.sql',import.meta.url),'utf8'));
const lock=await db.connect();
const {rows:[leader]}=await lock.query('SELECT pg_try_advisory_lock(7301024) AS acquired');
if(!leader.acquired)throw new Error('Another WhatsApp worker already owns this database');
async function log(level,event,groupId,jobId,detail){await db.query('INSERT INTO activity(level,event,group_id,job_id,detail) VALUES($1,$2,$3,$4,$5)',[level,event,groupId,jobId,String(detail).slice(0,1000)]);}
const wa=new WhatsApp(db,log), engine=new Engine(db,wa,log);
await engine.recover();
const app=Fastify({logger:{level:'info',redact:['req.headers.authorization']},bodyLimit:16384,requestTimeout:30000,trustProxy:process.env.TRUST_PROXY==='true'});
const origins=(process.env.DASHBOARD_ORIGINS||'').split(',').map(v=>v.trim()).filter(Boolean);
await app.register(cors,{origin:(origin,cb)=>cb(null,!origin||origins.includes(origin)),methods:['GET','POST'],allowedHeaders:['Authorization','Content-Type']});
await app.register(rateLimit,{max:120,timeWindow:'1 minute'});
const digest=v=>createHash('sha256').update(v).digest();
app.addHook('onRequest',async(req,reply)=>{
  reply.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer').header('Cache-Control','no-store');
  const routePath=req.routeOptions.url||req.url.split('?')[0];
  if(routePath.startsWith('/api/')&&routePath!=='/api/health'&&req.method!=='OPTIONS'){
    const supplied=req.headers.authorization?.replace(/^Bearer /,'')||'';
    if(!timingSafeEqual(digest(supplied),digest(key)))return reply.code(401).send({error:'Invalid admin access key'});
  }
});
app.setErrorHandler((e,req,reply)=>{req.log.error({message:e.message},'Request failed');reply.code(e.statusCode||400).send({error:e.code==='23505'?'This group already has an active job':e.message});});
app.get('/api/health',async()=>{await db.query('SELECT 1');return {ok:true};});
app.get('/api/state',async()=>{
  const [groups,jobs,activity,totals]=await Promise.all([
    db.query(`SELECT g.*,count(r.jid) FILTER(WHERE r.status='pending')::int AS pending FROM groups g LEFT JOIN requests r ON r.group_id=g.id GROUP BY g.id ORDER BY g.name`),
    db.query(`SELECT j.*,g.name AS group_name,(SELECT count(*)::int FROM job_items i WHERE i.job_id=j.id AND i.status IN ('uncertain','sending')) AS uncertain FROM jobs j JOIN groups g ON g.id=j.group_id ORDER BY j.created_at DESC LIMIT 100`),
    db.query('SELECT a.*,g.name AS group_name FROM activity a LEFT JOIN groups g ON g.id=a.group_id ORDER BY a.id DESC LIMIT 200'),
    db.query(`SELECT (SELECT COALESCE(sum(confirmed),0)::int FROM jobs) AS approved,(SELECT count(*)::int FROM job_items WHERE status='failed') AS failed`)
  ]);
  return {connection:{state:wa.state,qr:wa.qr,account:wa.state==='connected'?wa.socket?.user?.name:null},groups:groups.rows,jobs:jobs.rows,activity:activity.rows,totals:totals.rows[0]};
});
app.post('/api/connect',async()=>{await wa.connect();return {ok:true};});
app.post('/api/session/reset',async()=>{
  if(wa.state==='connected')throw new Error('Unlink this device in WhatsApp before clearing a live session');
  await wa.stop();await rm(process.env.AUTH_DIR||'/data/whatsapp',{recursive:true,force:true});
  await log('warn','session.reset',null,null,'Saved WhatsApp session cleared by admin');return {ok:true};
});
app.post('/api/sync',async()=>{await wa.sync();return {ok:true};});
app.post('/api/groups/:id/settings',async req=>{
  const {auto_enabled,capacity}=req.body||{};
  if(typeof auto_enabled!=='boolean'||!Number.isInteger(capacity)||capacity<1||capacity>1024)throw new Error('Capacity must be a whole number between 1 and 1,024');
  await wa.syncGroup(req.params.id); // Establish baseline before auto activation.
  const result=await db.query(`UPDATE groups SET auto_since=CASE WHEN $2 AND NOT auto_enabled THEN now() ELSE auto_since END, auto_enabled=$2,capacity=$3 WHERE id=$1 RETURNING id`,[req.params.id,auto_enabled,capacity]);
  if(!result.rowCount)throw new Error('Group not found');
  if(!auto_enabled)await db.query("UPDATE jobs SET status='cancelled',reason='Automatic approval disabled by admin',updated_at=now() WHERE group_id=$1 AND kind='auto' AND status IN ('queued','running','paused')",[req.params.id]);
  await log('info','group.settings',req.params.id,null,`Automatic approval ${auto_enabled?'enabled for future requests':'disabled'}; capacity ${capacity}`);return {ok:true};
});
app.post('/api/jobs',async req=>{
  const {group_id,kind,amount}=req.body||{};
  if(!['all','custom'].includes(kind))throw new Error('Choose Approve All or an exact amount');
  if(typeof group_id!=='string')throw new Error('Choose a group');
  await wa.syncGroup(group_id);
  return {id:await engine.create(group_id,kind,amount)};
});
app.get('/api/jobs/:id/items',async req=>({items:(await db.query('SELECT jid,status,attempts FROM job_items WHERE job_id=$1 ORDER BY ordinal',[req.params.id])).rows}));
app.post('/api/jobs/:id/control',async req=>{
  const {action}=req.body||{};
  if(!['pause','resume','cancel'].includes(action))throw new Error('Invalid action');
  const {rows:[job]}=await db.query('SELECT * FROM jobs WHERE id=$1',[req.params.id]);
  if(!job)throw new Error('Job not found');
  if(['completed','cancelled'].includes(job.status))throw new Error('This job has finished');
  if(action==='resume'){
    const {rows:[count]}=await db.query("SELECT count(*)::int AS n FROM job_items WHERE job_id=$1 AND status IN ('sending','uncertain')",[job.id]);
    if(count.n)throw new Error('Review uncertain approvals before resuming');
    if(job.status!=='paused')throw new Error('Only paused jobs can be resumed');
    await wa.syncGroup(job.group_id);
  }
  const status={pause:'paused',resume:'queued',cancel:'cancelled'}[action];
  await db.query('UPDATE jobs SET status=$2,reason=$3,updated_at=now() WHERE id=$1',[job.id,status,action==='resume'?null:`${action} requested by admin. An approval already in flight may still finish.`]);
  await log('info',`job.${action}`,job.group_id,job.id,`${action} requested by admin`);return {ok:true};
});
app.post('/api/jobs/:id/reconcile',async req=>{
  const {jid,outcome}=req.body||{};
  if(!['approved','pending','skip'].includes(outcome)||typeof jid!=='string')throw new Error('Choose an outcome');
  const {rows:[job]}=await db.query("SELECT * FROM jobs WHERE id=$1 AND status IN ('paused','cancelled')",[req.params.id]);
  if(!job)throw new Error('Pause the job before reviewing outcomes');
  if(engine.busy)throw new Error('Wait for the current worker operation to finish');
  const meta=await wa.syncGroup(job.group_id);
  const member=meta.participants.some(p=>participantMatches(p,jid));
  if(outcome==='approved'&&!member)throw new Error('Membership is not verified; cannot count as approved');
  if(outcome==='pending'){
    const pending=await wa.require().groupRequestParticipantsList(job.group_id);
    if(member||!pending.some(p=>p.jid===jid))throw new Error('This person is not verified as still pending');
  }
  const c=await db.connect();
  try{
    await c.query('BEGIN');
    const {rows:[locked]}=await c.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE',[job.id]);
    if(!['paused','cancelled'].includes(locked.status))throw new Error('Job state changed');
    if(outcome==='approved'&&locked.confirmed>=locked.target)throw new Error('Target already reached');
    const changed=await c.query("UPDATE job_items SET status=$3 WHERE job_id=$1 AND jid=$2 AND status IN ('uncertain','sending') RETURNING jid",[job.id,jid,{approved:'confirmed',pending:'pending',skip:'skipped'}[outcome]]);
    if(!changed.rowCount)throw new Error('No uncertain item found');
    if(outcome!=='approved')await c.query('UPDATE requests SET status=$3 WHERE group_id=$1 AND jid=$2',[job.group_id,jid,outcome==='pending'?'pending':'excluded']);
    if(outcome==='approved'){await c.query('UPDATE jobs SET confirmed=confirmed+1 WHERE id=$1',[job.id]);await c.query("UPDATE requests SET status='approved' WHERE group_id=$1 AND jid=$2",[job.group_id,jid]);}
    await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  await log('warn','approval.reviewed',job.group_id,job.id,`Admin reconciled an uncertain result as ${outcome}; ${member?'membership verified':'not a current member'}`);return {ok:true};
});
await app.register(staticFiles,{root:resolve('dist'),index:'index.html'});
await app.listen({port:Number(process.env.PORT)||3000,host:'0.0.0.0'});
const tick=setInterval(()=>engine.tick(),1500);
let syncing=false;
const sync=setInterval(async()=>{if(syncing||wa.state!=='connected')return;syncing=true;try{await wa.sync();}catch(e){await log('warn','sync.failed',null,null,e.message);}finally{syncing=false;}},60000);
await wa.connect();
async function shutdown(){engine.stopped=true;clearInterval(tick);clearInterval(sync);await wa.stop();await app.close();for(let i=0;engine.busy&&i<30;i++)await new Promise(r=>setTimeout(r,1000));await lock.query('SELECT pg_advisory_unlock(7301024)');lock.release();await db.end();process.exit(0);}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
