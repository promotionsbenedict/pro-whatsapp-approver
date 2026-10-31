import { ScopedDatabase } from './scoped-db.mjs';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { WhatsApp } from './whatsapp.mjs';
import { Engine } from './engine.mjs';
import { checkedSchema } from './auth.mjs';
export async function initializeAccounts(db){
 await db.query(await readFile(new URL('./accounts.sql',import.meta.url),'utf8'));
 const c=await db.connect();
 try{
  await c.query('BEGIN');await c.query('CREATE SCHEMA IF NOT EXISTS legacy');
  // Existing tables keep their rows, indexes, sequences and foreign keys when moved.
  for(const table of ['groups','requests','jobs','job_items','activity']){
   const {rows:[r]}=await c.query('SELECT to_regclass($1) AS existing',[`public.${table}`]);
   if(r.existing)await c.query(`ALTER TABLE public.${table} SET SCHEMA legacy`);
  }
  await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
export function authDirectory(user,base=process.env.AUTH_DIR||'/data/whatsapp'){
 checkedSchema(user.schema_name);
 return user.legacy?resolve(base):resolve(dirname(base),'accounts',user.id);
}
export class Tenants {
 runtimes=new Map();pending=new Map();stopped=false;
 constructor(globalDb,{poolFactory,waFactory,engineFactory,maxConnected=Number(process.env.MAX_CONNECTED_ACCOUNTS)||20}={}){
  this.globalDb=globalDb;this.maxConnected=maxConnected;
  this.poolFactory=poolFactory||((schema)=>new ScopedDatabase(globalDb,schema));
  this.waFactory=waFactory||((db,log,authDir)=>new WhatsApp(db,log,authDir));
  this.engineFactory=engineFactory||((db,wa,log)=>new Engine(db,wa,log));
 }
 async get(user){
  if(this.stopped)throw new Error('Service is shutting down');
  if(this.runtimes.has(user.id))return this.runtimes.get(user.id);
  if(this.pending.has(user.id))return this.pending.get(user.id);
  const pending=this.create(user);this.pending.set(user.id,pending);
  try{return await pending;}finally{this.pending.delete(user.id);}
 }
 async create(user){
  const schema=checkedSchema(user.schema_name),db=this.poolFactory(schema);
  try{
   await db.query(await readFile(new URL('./schema.sql',import.meta.url),'utf8'));
   const log=(level,event,groupId,jobId,detail)=>db.query('INSERT INTO activity(level,event,group_id,job_id,detail) VALUES($1,$2,$3,$4,$5)',[level,event,groupId,jobId,String(detail).slice(0,1000)]);
   const authDir=authDirectory(user),wa=this.waFactory(db,log,authDir),engine=this.engineFactory(db,wa,log);
   wa.onRequests=()=>engine.tick().catch(e=>log('error','worker.error',null,null,e.message).catch(()=>{}));
   await engine.recover();const context={db,wa,engine,log,authDir,user,syncing:false,started:false};this.runtimes.set(user.id,context);return context;
  }catch(e){await db.end();throw e;}
 }
 async start(user){
  const ctx=await this.get(user);
  if(!ctx.started&&[...this.runtimes.values()].filter(r=>r.started).length>=this.maxConnected)throw Object.assign(new Error('The server has reached its active WhatsApp connection capacity. Please try later.'),{statusCode:503});
  ctx.started=true;
  await this.globalDb.query('UPDATE public.app_users SET wa_started=true WHERE id=$1',[user.id]);
  await ctx.wa.connect();return ctx;
 }
 async disconnect(user){const c=await this.get(user);await c.wa.stop();c.started=false;await this.globalDb.query('UPDATE public.app_users SET wa_started=false WHERE id=$1',[user.id]);return c;}
 async restore(){const {rows}=await this.globalDb.query('SELECT * FROM public.app_users WHERE wa_started ORDER BY created_at');for(const u of rows.slice(0,this.maxConnected))await this.start(u).catch(e=>console.error('Account connection restore failed:',e.message));}
 tick(){for(const ctx of this.runtimes.values())ctx.engine.tick();}
 async sync(){await Promise.allSettled([...this.runtimes.values()].map(async c=>{if(c.syncing||c.wa.state!=='connected')return;c.syncing=true;try{await c.wa.sync();}catch(e){await c.log('warn','sync.failed',null,null,e.message);}finally{c.syncing=false;}}));}
 async close(){this.stopped=true;for(const c of this.runtimes.values()){c.engine.stopped=true;await c.wa.stop();}for(let n=0;n<35&&[...this.runtimes.values()].some(c=>c.engine.busy);n++)await new Promise(r=>setTimeout(r,1000));await Promise.all([...this.runtimes.values()].map(c=>c.db.end()));}
}
