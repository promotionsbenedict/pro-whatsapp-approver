import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { resolve } from 'node:path';
import { publicUser } from './auth.mjs';
import { registerApprovalRoutes } from './routes.mjs';
export async function buildApp({db,accounts,manager,origins,secureCookie=true,logger=true}){
 const app=Fastify({logger:logger?{level:'info',redact:['req.headers.authorization','req.headers.cookie','res.headers.set-cookie']}:false,bodyLimit:16384,requestTimeout:30000,trustProxy:process.env.TRUST_PROXY==='true'?1:false});
 await app.register(cors,{origin:(origin,cb)=>cb(null,!origin||origins.includes(origin)),methods:['GET','POST'],allowedHeaders:['Content-Type'],credentials:true});
 await app.register(rateLimit,{max:120,timeWindow:'1 minute'});
 const cookie=(token,expired=false)=>`pro_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${expired?0:2592000}${secureCookie?'; Secure':''}`;
 const publicRoutes=new Set(['/api/health','/api/auth/register','/api/auth/login']);
 app.addHook('onRequest',async(req,reply)=>{
  reply.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer').header('Cache-Control','no-store');
  const path=req.routeOptions.url||req.url.split('?')[0];
  if(!path.startsWith('/api/')||req.method==='OPTIONS')return;
  if(req.method==='POST'){
   if(!origins.includes(req.headers.origin))return reply.code(403).send({error:'Use the application website to submit this request'});
   if(!req.headers['content-type']?.startsWith('application/json'))return reply.code(415).send({error:'JSON content required'});
  }
  if(!publicRoutes.has(path)){
   req.user=await accounts.authenticate(req.headers.cookie);
   if(!req.user)return reply.code(401).send({error:'Sign in to your account'});
  }
 });
 app.setErrorHandler((e,req,reply)=>{req.log.error({message:e.message},'Request failed');const internal=e.code&&e.code!=='23505'&&!e.statusCode;reply.code(internal?500:e.statusCode||400).send({error:internal?'The request could not be completed. Please try again.':e.code==='23505'?'This group already has an active job':e.message});});
 app.get('/api/health',async()=>{await db.query('SELECT 1');return {ok:true,version:'2.0.0'};});
 app.post('/api/auth/register',{config:{rateLimit:{max:5,timeWindow:'1 hour'}}},async(req,reply)=>{const user=await accounts.register(req.body);reply.header('Set-Cookie',cookie(await accounts.session(user)));return {user:publicUser(user)};});
 app.post('/api/auth/login',{config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async(req,reply)=>{const user=await accounts.login(req.body);reply.header('Set-Cookie',cookie(await accounts.session(user)));return {user:publicUser(user)};});
 app.get('/api/auth/me',async req=>({user:publicUser(req.user)}));
 app.post('/api/auth/logout',async(req,reply)=>{await accounts.logout(req.headers.cookie);reply.header('Set-Cookie',cookie('',true));return {ok:true};});
 app.post('/api/auth/password',{config:{rateLimit:{max:5,timeWindow:'15 minutes'}}},async(req,reply)=>{await accounts.changePassword(req.user,req.body?.current_password,req.body?.new_password);reply.header('Set-Cookie',cookie(await accounts.session(req.user)));return {ok:true};});
 app.post('/api/disconnect',async req=>{const ctx=await manager.disconnect(req.user);await ctx.log('info','connection.stopped',null,null,'Background WhatsApp connection stopped by account owner');return {ok:true};});
 registerApprovalRoutes(app,manager);
 await app.register(staticFiles,{root:resolve('dist'),index:'index.html'});
 return app;
}
