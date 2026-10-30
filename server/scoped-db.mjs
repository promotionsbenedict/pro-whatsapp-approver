import { checkedSchema } from './auth.mjs';
// A shared, bounded PostgreSQL pool. Search paths apply only within a transaction
// and disappear on COMMIT/ROLLBACK, including when the connection is reused.
export class ScopedDatabase {
 constructor(pool,schema){this.pool=pool;this.schema=checkedSchema(schema);}
 async connect(){
  const c=await this.pool.connect();let active=false,released=false;
  return {
   query:async(sql,args)=>{
    const command=sql.trim().toUpperCase();
    if(command==='BEGIN'){
     const r=await c.query('BEGIN');active=true;
     await c.query(`SET LOCAL search_path TO "${this.schema}",pg_catalog`);return r;
    }
    if(!active)throw new Error('Scoped database queries require a transaction');
    const result=await c.query(sql,args);
    if(command==='COMMIT'||command==='ROLLBACK')active=false;
    return result;
   },
   release(){if(released)return;released=true;if(active)c.query('ROLLBACK').then(()=>c.release()).catch(e=>c.release(e));else c.release();}
  };
 }
 async query(sql,args){const c=await this.connect();try{await c.query('BEGIN');const result=await c.query(sql,args);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}}
 async end(){} // The application owns and closes the shared pool.
}
