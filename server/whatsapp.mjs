import makeWASocket, { useMultiFileAuthState, DisconnectReason, jidNormalizedUser } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import { isAdmin } from './policy.mjs';
import { retryRead } from './retry.mjs';
export class WhatsApp {
  socket = null; state = 'disconnected'; qr = null; retry = 0; timer = null; stopped = false; generation = 0;
  constructor(db, log) { this.db=db; this.log=log; }
  get ownIds() { return [this.socket?.user?.id,this.socket?.user?.lid].filter(Boolean).map(jidNormalizedUser); }
  async connect() {
    if (['connecting','connected','qr'].includes(this.state)) return;
    this.stopped=false; clearTimeout(this.timer); this.state='connecting';
    const generation=++this.generation;
    try {
      const { state, saveCreds } = await useMultiFileAuthState(process.env.AUTH_DIR || '/data/whatsapp');
      const socket=makeWASocket({auth:state,logger:pino({level:'silent'}),markOnlineOnConnect:false,connectTimeoutMs:30000,defaultQueryTimeoutMs:30000,syncFullHistory:false});
      this.socket=socket;
      socket.ev.on('creds.update',saveCreds);
      socket.ev.on('connection.update',async update=>{
        if (generation!==this.generation) return;
        if(update.qr){ this.qr=await QRCode.toDataURL(update.qr); this.state='qr'; }
        if(update.connection==='open'){
          this.state='connected';this.qr=null;this.retry=0;
          await this.log('info','connection.open',null,null,'WhatsApp connected');
          await this.sync().catch(e=>this.log('error','sync.failed',null,null,e.message));
        }
        if(update.connection==='close'){
          this.qr=null;
          const code=update.lastDisconnect?.error?.output?.statusCode;
          this.state=code===DisconnectReason.loggedOut?'logged_out':'disconnected';
          await this.log('warn','connection.closed',null,null,this.state==='logged_out'?'Session revoked. Clear the saved session and pair again.':'Connection lost; approvals are waiting for reconnect.');
          if(!this.stopped && this.state!=='logged_out') this.timer=setTimeout(()=>this.connect(),Math.min(60000,2000*2**Math.min(this.retry++,5)));
        }
      });
      socket.ev.on('group.join-request',async event=>{
        if(generation!==this.generation || this.state!=='connected') return;
        await this.syncGroup(event.id).catch(e=>this.log('error','requests.sync_failed',event.id,null,e.message));
      });
    } catch(e){this.state='disconnected';await this.log('error','connection.failed',null,null,e.message);if(!this.stopped)this.timer=setTimeout(()=>this.connect(),15000);}
  }
  require(){if(this.state!=='connected')throw new Error('WhatsApp is not connected');return this.socket;}
  async sync() {
    const groups=await retryRead(()=>this.require().groupFetchAllParticipating());
    const ids=Object.keys(groups);
    if(ids.length) await this.db.query('UPDATE groups SET is_admin=false, error=$1 WHERE NOT(id=ANY($2::text[]))',['Account no longer belongs to this group',ids]);
    else await this.db.query('UPDATE groups SET is_admin=false,error=$1',['Account does not belong to any group']);
    for(const meta of Object.values(groups)) {
      await this.db.query(`INSERT INTO groups(id,name,member_count,is_admin) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET name=$2,member_count=$3,is_admin=$4`,[meta.id,meta.subject,meta.size??meta.participants.length,isAdmin(meta,this.ownIds)]);
      if(isAdmin(meta,this.ownIds)) await this.syncGroup(meta.id).catch(e=>this.db.query('UPDATE groups SET error=$2 WHERE id=$1',[meta.id,e.message]));
    }
  }
  async syncGroup(id) {
    const socket=this.require();
    const meta=await retryRead(()=>socket.groupMetadata(id));
    if(!isAdmin(meta,this.ownIds)){
      await this.db.query('UPDATE groups SET is_admin=false,error=$2 WHERE id=$1',[id,'Connected account must be a group admin']);
      throw new Error('Connected account must be a group admin');
    }
    const pending=await retryRead(()=>socket.groupRequestParticipantsList(id));
    const client=await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM groups WHERE id=$1 FOR UPDATE',[id]);
      for(const p of pending) {
        if(!p.jid) continue;
        const stamp=Number(p.request_time);
        await client.query(`INSERT INTO requests(group_id,jid,requested_at) VALUES($1,$2,$3) ON CONFLICT(group_id,jid) DO UPDATE SET status=CASE WHEN requests.status IN ('gone','approved') THEN 'pending' ELSE requests.status END,first_seen=CASE WHEN requests.status IN ('gone','approved') THEN now() ELSE requests.first_seen END`,[id,p.jid,stamp>0?new Date(stamp*1000):null]);
      }
      await client.query(`UPDATE requests SET status='gone' WHERE group_id=$1 AND status='pending' AND NOT(jid=ANY($2::text[]))`,[id,pending.map(p=>p.jid).filter(Boolean)]);
      await client.query('UPDATE groups SET baseline_at=COALESCE(baseline_at,now()),synced_at=now(),member_count=$2,is_admin=true,error=null WHERE id=$1',[id,meta.size??meta.participants.length]);
      await client.query('COMMIT');
    } catch(e){await client.query('ROLLBACK');throw e;} finally{client.release();}
    return meta;
  }
  async stop(){this.stopped=true;clearTimeout(this.timer);++this.generation;this.socket?.end(new Error('Service shutdown'));this.state='disconnected';}
}
