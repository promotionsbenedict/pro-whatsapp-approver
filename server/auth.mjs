import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt=promisify(scryptCallback);
export const hashToken=token=>createHash('sha256').update(token).digest('hex');
export const safeEqual=(a,b)=>timingSafeEqual(Buffer.from(hashToken(a)),Buffer.from(hashToken(b)));
export function validatePassword(password){if(typeof password!=='string'||password.length<12||Buffer.byteLength(password)>512)throw Object.assign(new Error('Use a password of at least 12 characters (maximum 512 bytes)'),{statusCode:400});}
export async function hashPassword(password){validatePassword(password);const salt=randomBytes(16).toString('hex');const key=await scrypt(password,salt,64,{N:32768,r:8,p:1,maxmem:67108864});return `scrypt:${salt}:${key.toString('hex')}`;}
export async function verifyPassword(password,encoded){
 if(typeof password!=='string'||Buffer.byteLength(password)>512)return false;
 const [,salt,hex]=encoded.split(':');if(!salt||!hex)return false;
 const key=await scrypt(password,salt,64,{N:32768,r:8,p:1,maxmem:67108864});
 const expected=Buffer.from(hex,'hex');return key.length===expected.length&&timingSafeEqual(key,expected);
}
export function schemaFor(id){if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))throw new Error('Invalid account ID');return 'u_'+id.replaceAll('-','');}
export function checkedSchema(schema){if(schema!=='legacy'&&!/^u_[0-9a-f]{32}$/.test(schema))throw new Error('Invalid tenant schema');return schema;}
export function publicUser(u){return {id:u.id,name:u.name,email:u.email,legacy:u.legacy};}
export class Accounts {
 constructor(db,{legacyKey=process.env.ADMIN_API_KEY||''}={}){this.db=db;this.legacyKey=legacyKey;}
 async register({name,email,password,legacy_key}={}){
  if(typeof name!=='string'||!name.trim()||name.trim().length>80)throw new Error('Enter your name (up to 80 characters)');
  if(typeof email!=='string'||email.length>254||!/^\S+@\S+\.\S+$/.test(email))throw new Error('Enter a valid email address');
  if(legacy_key&&(!this.legacyKey||!safeEqual(legacy_key,this.legacyKey)))throw new Error('The migration key is incorrect');
  const passwordHash=await hashPassword(password),id=randomUUID(),legacy=Boolean(legacy_key),schema=legacy?'legacy':schemaFor(id);
  const c=await this.db.connect();
  try{
   await c.query('BEGIN');
   await c.query(`CREATE SCHEMA IF NOT EXISTS "${checkedSchema(schema)}"`);
   const {rows:[user]}=await c.query('INSERT INTO public.app_users(id,name,email,password_hash,schema_name,legacy) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[id,name.trim(),email.trim().toLowerCase(),passwordHash,schema,legacy]);
   await c.query('COMMIT');return user;
  }catch(e){await c.query('ROLLBACK');if(e.code==='23505')throw Object.assign(new Error(legacy?'This email or the existing owner workspace has already been registered':'An account with this email already exists'),{statusCode:409});throw e;}finally{c.release();}
 }
 async login({email,password}={}){
  const {rows:[user]}=await this.db.query('SELECT * FROM public.app_users WHERE email=$1',[typeof email==='string'?email.trim().toLowerCase():'']);
  // Perform the same expensive hash when the account is absent to reduce account enumeration.
  const encoded=user?.password_hash||`scrypt:${'0'.repeat(32)}:${'0'.repeat(128)}`;
  if(!await verifyPassword(password,encoded)||!user)throw Object.assign(new Error('Email or password is incorrect'),{statusCode:401});return user;
 }
 async session(user){const token=randomBytes(32).toString('hex');await this.db.query('INSERT INTO public.app_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval \'30 days\')',[hashToken(token),user.id]);return token;}
 async authenticate(cookie){const token=String(cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith('pro_session='))?.slice(12);if(!/^[0-9a-f]{64}$/.test(token||''))return null;const {rows:[user]}=await this.db.query('SELECT u.* FROM public.app_users u JOIN public.app_sessions s ON s.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at>now()',[hashToken(token)]);return user||null;}
 async logout(cookie){const token=String(cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith('pro_session='))?.slice(12);if(token)await this.db.query('DELETE FROM public.app_sessions WHERE token_hash=$1',[hashToken(token)]);}
 async changePassword(user,current,next){if(!await verifyPassword(current,user.password_hash))throw Object.assign(new Error('Current password is incorrect'),{statusCode:403});const hash=await hashPassword(next);const c=await this.db.connect();try{await c.query('BEGIN');await c.query('UPDATE public.app_users SET password_hash=$2 WHERE id=$1',[user.id,hash]);await c.query('DELETE FROM public.app_sessions WHERE user_id=$1',[user.id]);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
}
