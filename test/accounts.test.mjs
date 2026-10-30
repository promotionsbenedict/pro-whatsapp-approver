import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Accounts, schemaFor, checkedSchema, hashPassword, verifyPassword } from '../server/auth.mjs';
import { Tenants, initializeAccounts, authDirectory } from '../server/tenants.mjs';
import { buildApp } from '../server/app.mjs';
// One PostgreSQL-compatible database, serialized sessions with independent search_path.
// Production uses a separate pg.Pool with a fixed search_path for each workspace.
async function harness(){
 const pg=new PGlite();let tail=Promise.resolve();
 async function acquire(){let release;const next=new Promise(r=>release=r),previous=tail;tail=next;await previous;return release;}
 const execute=async(sql,args)=>{const r=/^CREATE TABLE/i.test(sql.trim())&&sql.includes(';')?(await pg.exec(sql)).at(-1):await pg.query(sql,args);return {...r,rowCount:r.affectedRows??r.rows?.length??0};};
 const pool=schema=>({async connect(){const release=await acquire();try{await pg.exec(`SET search_path TO ${checkedSchemaForTest(schema)},pg_catalog`);}catch(e){release();throw e;}return {query:execute,release};},async query(sql,args){const c=await this.connect();try{return await c.query(sql,args);}finally{c.release();}},async end(){}});
 function checkedSchemaForTest(s){if(s==='public')return s;return checkedSchema(s);}
 return {pg,db:pool('public'),pool};
}
test('password hashing, verification and tenant schema validation',async()=>{
 const hash=await hashPassword('a strong password 123');assert.notEqual(hash,'a strong password 123');assert.equal(await verifyPassword('a strong password 123',hash),true);assert.equal(await verifyPassword('wrong password',hash),false);await assert.rejects(hashPassword('short'));assert.throws(()=>schemaFor('../../shared'));assert.throws(()=>checkedSchema('public'));assert.throws(()=>checkedSchema('legacy;DROP TABLE groups'));assert.notEqual(schemaFor(randomUUID()),schemaFor(randomUUID()));
});
test('multi-user API, database isolation, migration and persistent sessions',async t=>{
 const h=await harness();t.after(()=>h.pg.close());
 await h.db.query(await readFile(new URL('../server/schema.sql',import.meta.url),'utf8'));
 await h.db.query("INSERT INTO groups(id,name,is_admin) VALUES('original','Original owner group',true)");
 await initializeAccounts(h.db);
 const key='migration-secret-only-the-original-owner-knows';
 const accounts=new Accounts(h.db,{legacyKey:key});
 const waFactory=(db,log,authDir)=>({state:'disconnected',qr:null,authDir,socket:null,ownIds:['owner'],async connect(){this.state='connected';this.socket={user:{name:'Paired account'}};},async stop(){this.state='disconnected';},async sync(){},async syncGroup(id){const {rows:[g]}=await db.query('SELECT * FROM groups WHERE id=$1',[id]);if(!g)throw new Error('Group not found');return {size:g.member_count,participants:[{id:'owner',admin:'admin'}]};}});
 const manager=new Tenants(h.db,{waFactory,maxConnected:1});
 const origin='https://approver.test';const app=await buildApp({db:h.db,accounts,manager,origins:[origin],secureCookie:true,logger:false});await app.ready();t.after(()=>app.close());
 const call=(method,url,cookie,payload,requestOrigin=origin)=>app.inject({method,url,headers:{origin:requestOrigin,...(cookie?{cookie}:{}),...(payload!==undefined?{'content-type':'application/json'}:{})},payload});
 const cookieOf=r=>r.headers['set-cookie'].split(';')[0];
 let aliceCookie,bobCookie,alice,bob,ca,cb,bobJob;
 await t.test('anonymous callers and the old shared key cannot access user data',async()=>{assert.equal((await call('GET','/api/state')).statusCode,401);assert.equal((await app.inject({url:'/api/state',headers:{authorization:`Bearer ${key}`}})).statusCode,401);});
 await t.test('anyone can register; the session uses Secure HttpOnly cookies',async()=>{
  const a=await call('POST','/api/auth/register',null,{name:'Alice',email:'ALICE@example.com',password:'alice password 123'});assert.equal(a.statusCode,200,a.body);aliceCookie=cookieOf(a);assert.match(a.headers['set-cookie'],/HttpOnly/);assert.match(a.headers['set-cookie'],/Secure/);assert.match(a.headers['set-cookie'],/SameSite=Lax/);assert.equal(a.json().user.email,'alice@example.com');assert.equal(a.json().user.password_hash,undefined);
  const b=await call('POST','/api/auth/register',null,{name:'Bob',email:'bob@example.com',password:'bob password 123'});assert.equal(b.statusCode,200,b.body);bobCookie=cookieOf(b);
  alice=await accounts.authenticate(aliceCookie);bob=await accounts.authenticate(bobCookie);assert.notEqual(alice.schema_name,bob.schema_name);
 });
 await t.test('same account initialization is deduplicated; auth paths do not overlap',async()=>{
  [ca]=await Promise.all([manager.get(alice),manager.get(alice)]);cb=await manager.get(bob);assert.equal(await manager.get(alice),ca);assert.notEqual(ca.authDir,cb.authDir);assert.notEqual(ca.authDir,authDirectory({id:randomUUID(),schema_name:'legacy',legacy:true}));assert.notEqual(ca.wa,cb.wa);
 });
 await t.test('groups, requests, jobs, logs and pairing QR codes are account-scoped',async()=>{
  for(const [ctx,name] of [[ca,'Alice'],[cb,'Bob']]){await ctx.db.query('INSERT INTO groups(id,name,is_admin) VALUES($1,$2,true)',['same-whatsapp-group',name+' group']);await ctx.db.query('INSERT INTO activity(level,event,detail) VALUES($1,$2,$3)',['info','account.test',name+' private log']);ctx.wa.qr=name+' private QR';}
  bobJob=randomUUID();await cb.db.query("INSERT INTO jobs(id,group_id,kind,target) VALUES($1,'same-whatsapp-group','custom',1)",[bobJob]);await cb.db.query("INSERT INTO job_items(job_id,jid,ordinal) VALUES($1,'bob-only-request',0)",[bobJob]);
  const a=await call('GET','/api/state',aliceCookie),b=await call('GET','/api/state',bobCookie);assert.equal(a.statusCode,200,a.body);assert.equal(a.json().groups[0].name,'Alice group');assert.equal(b.json().groups[0].name,'Bob group');assert.equal(a.json().groups.length,1);assert.equal(a.json().jobs.length,0);assert.equal(b.json().jobs.length,1);assert.equal(a.json().activity[0].detail,'Alice private log');assert.equal(a.json().connection.qr,'Alice private QR');assert.equal(b.json().connection.qr,'Bob private QR');assert.equal(a.body.includes('Original owner group'),false);assert.equal(a.body.includes('Bob private'),false);
 });
 await t.test('guessed job IDs cannot read, cancel, resume or reconcile another user’s job',async()=>{
  assert.equal((await call('GET',`/api/jobs/${bobJob}/items`,aliceCookie)).statusCode,404);
  for(const action of ['cancel','pause','resume'])assert.notEqual((await call('POST',`/api/jobs/${bobJob}/control`,aliceCookie,{action})).statusCode,200);
  assert.notEqual((await call('POST',`/api/jobs/${bobJob}/reconcile`,aliceCookie,{jid:'bob-only-request',outcome:'skip'})).statusCode,200);
  assert.equal((await cb.db.query('SELECT status FROM jobs WHERE id=$1',[bobJob])).rows[0].status,'queued');
 });
 await t.test('group settings on identical WhatsApp IDs remain separate',async()=>{
  const r=await call('POST','/api/groups/same-whatsapp-group/settings',aliceCookie,{auto_enabled:true,capacity:500});assert.equal(r.statusCode,200,r.body);assert.equal((await ca.db.query('SELECT capacity FROM groups')).rows[0].capacity,500);assert.equal((await cb.db.query('SELECT capacity FROM groups')).rows[0].capacity,1024);
 });
 await t.test('cross-origin mutations and expired sessions are rejected',async()=>{
  assert.equal((await call('POST','/api/groups/same-whatsapp-group/settings',aliceCookie,{auto_enabled:false,capacity:10},'https://evil.test')).statusCode,403);
  const token=await accounts.session(alice);await h.db.query("UPDATE public.app_sessions SET expires_at=now()-interval '1 hour' WHERE token_hash=(SELECT token_hash FROM public.app_sessions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1)",[alice.id]);assert.equal((await call('GET','/api/state','pro_session='+token)).statusCode,401);
 });
 await t.test('connection capacity does not prevent others from signing in or viewing their own workspace',async()=>{
  assert.equal((await call('POST','/api/connect',aliceCookie,{})).statusCode,200);
  assert.equal((await call('POST','/api/connect',bobCookie,{})).statusCode,503);
  assert.equal((await call('GET','/api/state',bobCookie)).statusCode,200);
  assert.equal(ca.wa.state,'connected');assert.equal(cb.wa.state,'disconnected');
 });
 await t.test('only the original migration key can claim existing data and session path',async()=>{
  assert.notEqual((await call('POST','/api/auth/register',null,{name:'Imposter',email:'bad@example.com',password:'not a real password 123',legacy_key:'wrong'})).statusCode,200);
  // Registration route is rate-limited; use the same Accounts service for additional migration cases.
  const owner=await accounts.register({name:'Original owner',email:'owner@example.com',password:'owner password 123',legacy_key:key});const original=await manager.get(owner);assert.equal(original.authDir,authDirectory(owner));assert.equal((await original.db.query('SELECT name FROM groups')).rows[0].name,'Original owner group');
  await assert.rejects(accounts.register({name:'Second',email:'second-owner@example.com',password:'owner password 234',legacy_key:key}),/already been registered/);
 });
 await t.test('password change revokes other sessions and issues a usable replacement',async()=>{
  const second='pro_session='+await accounts.session(alice);
  const r=await call('POST','/api/auth/password',aliceCookie,{current_password:'alice password 123',new_password:'new alice password 456'});assert.equal(r.statusCode,200,r.body);
  assert.equal((await call('GET','/api/auth/me',aliceCookie)).statusCode,401);assert.equal((await call('GET','/api/auth/me',second)).statusCode,401);aliceCookie=cookieOf(r);assert.equal((await call('GET','/api/auth/me',aliceCookie)).statusCode,200);assert.equal((await call('GET','/api/auth/me',bobCookie)).statusCode,200);
 });
 await t.test('logout revokes only that browser session and keeps background jobs running',async()=>{
  assert.equal((await call('POST','/api/auth/logout',aliceCookie,{})).statusCode,200);assert.equal((await call('GET','/api/state',aliceCookie)).statusCode,401);assert.equal(ca.wa.state,'connected');assert.equal((await call('GET','/api/auth/me',bobCookie)).statusCode,200);
 });
 await t.test('fresh login survives account service recreation and original password no longer works',async()=>{
  assert.equal((await call('POST','/api/auth/login',null,{email:'alice@example.com',password:'alice password 123'})).statusCode,401);
  const r=await call('POST','/api/auth/login',null,{email:'alice@example.com',password:'new alice password 456'});assert.equal(r.statusCode,200,r.body);const fresh=new Accounts(h.db);assert.equal((await fresh.authenticate(cookieOf(r))).id,alice.id);
 });
 await t.test('a reused database connection resets tenant search paths after success and failure',async()=>{
  await ca.db.query('SELECT count(*) FROM groups');assert.equal((await h.pg.query('SELECT current_schema() AS schema')).rows[0].schema,'public');
  await assert.rejects(ca.db.query('SELECT * FROM no_such_table'));
  assert.equal((await h.pg.query('SELECT current_schema() AS schema')).rows[0].schema,'public');
  assert.equal((await cb.db.query('SELECT name FROM groups')).rows[0].name,'Bob group');
 });
 await t.test('two accounts can create independent approval jobs for the same group ID',async()=>{
  for(const ctx of [ca,cb]){await ctx.db.query("INSERT INTO groups(id,name,is_admin) VALUES('another-group','Shared ID, private job',true)");await ctx.db.query("INSERT INTO requests(group_id,jid) VALUES('another-group','pending-person')");}
  const a=await ca.engine.create('another-group','custom',1),b=await cb.engine.create('another-group','custom',1);assert.notEqual(a,b);
  assert.equal((await ca.db.query('SELECT * FROM jobs WHERE id=$1',[b])).rowCount,0);assert.equal((await cb.db.query('SELECT * FROM jobs WHERE id=$1',[a])).rowCount,0);
 });
 await t.test('startup recovery affects only the selected tenant’s jobs',async()=>{
  const aliceJob=randomUUID();await ca.db.query("INSERT INTO jobs(id,group_id,kind,target,status) VALUES($1,'same-whatsapp-group','custom',1,'running')",[aliceJob]);await cb.db.query("UPDATE jobs SET status='running' WHERE id=$1",[bobJob]);
  const freshManager=new Tenants(h.db,{waFactory});await freshManager.get(alice);
  assert.equal((await ca.db.query('SELECT status FROM jobs WHERE id=$1',[aliceJob])).rows[0].status,'queued');assert.equal((await cb.db.query('SELECT status FROM jobs WHERE id=$1',[bobJob])).rows[0].status,'running');
 });
});
