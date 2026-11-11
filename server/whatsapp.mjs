import makeWASocket, { useMultiFileAuthState, DisconnectReason, jidNormalizedUser } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import { isAdmin } from './policy.mjs';
import { retryRead } from './retry.mjs';
export class WhatsApp {
  socket = null; state = 'disconnected'; qr = null; retry = 0; timer = null; stopped = false; generation = 0;
  authOperations = new Set();

  constructor(db, log, authDir = process.env.AUTH_DIR || '/data/whatsapp', dependencies = {}) {
    this.db = db;
    this.log = log;
    this.authDir = authDir;
    this.loadAuth = dependencies.loadAuth ?? useMultiFileAuthState;
    this.makeSocket = dependencies.makeSocket ?? makeWASocket;
    this.renderQr = dependencies.renderQr ?? QRCode.toDataURL;
  }

  get ownIds() { return [this.socket?.user?.id,this.socket?.user?.lid].filter(Boolean).map(jidNormalizedUser); }

  async trackAuth(operation) {
    const pending = operation();
    this.authOperations.add(pending);
    try {
      return await pending;
    } finally {
      this.authOperations.delete(pending);
    }
  }

  async connect() {
    if (['connecting', 'connected', 'qr'].includes(this.state)) return;
    this.stopped = false;
    clearTimeout(this.timer);
    this.state = 'connecting';
    this.qr = null;
    const generation = ++this.generation;
    const isCurrent = () => generation === this.generation;
    try {
      await Promise.allSettled(this.authOperations);
      if (!isCurrent()) return;
      const { state, saveCreds } = await this.trackAuth(() => this.loadAuth(this.authDir));
      if (!isCurrent()) return;
      const keys = {
        get: state.keys.get,
        set: async data => {
          if (!isCurrent()) return;
          await this.trackAuth(async () => {
            // The file store writes each key separately. Drain every write even
            // if one fails, so reset can safely remove the credential directory.
            const writes = Object.entries(data).flatMap(([category, entries]) =>
              Object.entries(entries).map(([id, value]) => state.keys.set({[category]:{[id]:value}})));
            const results = await Promise.allSettled(writes);
            const failure = results.find(result => result.status === 'rejected');
            if (failure) throw failure.reason;
          });
        },
      };
      const socket = this.makeSocket({auth:{creds:state.creds,keys},logger:pino({level:'silent'}),markOnlineOnConnect:false,connectTimeoutMs:30000,defaultQueryTimeoutMs:30000,syncFullHistory:false});
      this.socket = socket;
      socket.ev.on('creds.update', () => {
        if (!isCurrent()) return;
        return this.trackAuth(saveCreds).catch(error => this.log('error', 'connection.save_failed', null, null, error.message));
      });
      let qrRevision = 0;
      socket.ev.on('connection.update', async update => {
        if (!isCurrent()) return;
        if (update.connection === 'close') {
          const closedGeneration = ++this.generation;
          this.socket = null;
          this.qr = null;
          const code = update.lastDisconnect?.error?.output?.statusCode;
          this.state = code === DisconnectReason.loggedOut ? 'logged_out' : 'disconnected';
          if (!this.stopped && this.state !== 'logged_out') {
            const delay = code === DisconnectReason.restartRequired ? 0 : Math.min(60000, 2000 * 2 ** Math.min(this.retry++, 5));
            this.scheduleReconnect(closedGeneration, delay);
          }
          await this.log('warn','connection.closed',null,null,this.state==='logged_out'?'Session revoked. Clear the saved session and pair again.':'Connection lost; approvals are waiting for reconnect.');
          return;
        }
        if (update.connection === 'open') {
          qrRevision++;
          this.state = 'connected';
          this.qr = null;
          this.retry = 0;
          await this.log('info','connection.open',null,null,'WhatsApp connected');
          if (isCurrent()) await this.sync().catch(e=>this.log('error','sync.failed',null,null,e.message));
          return;
        }
        if (update.isNewLogin && this.state !== 'connected') {
          qrRevision++;
          this.qr = null;
          this.state = 'connecting';
          return;
        }
        if (update.qr && this.state !== 'connected') {
          const revision = ++qrRevision;
          this.qr = null;
          this.state = 'connecting';
          const qr = await this.renderQr(update.qr);
          if (isCurrent() && revision === qrRevision) {
            this.qr = qr;
            this.state = 'qr';
          }
        }
      });
      socket.ev.on('group.join-request',async event=>{
        if(!isCurrent() || this.state!=='connected') return;
        await this.syncGroup(event.id).then(()=>{if(isCurrent())return this.onRequests?.();}).catch(e=>this.log('error','requests.sync_failed',event.id,null,e.message));
      });
    } catch(e){
      if (!isCurrent()) return;
      this.state = 'disconnected';
      this.scheduleReconnect(generation, 15000);
      await this.log('error','connection.failed',null,null,e.message);
    }
  }

  scheduleReconnect(generation, delay) {
    this.timer = setTimeout(() => {
      if (!this.stopped && this.generation === generation) return this.connect();
    }, delay);
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
  async readMetadata(id) {
    const meta=await retryRead(()=>this.require().groupMetadata(id));
    if(!isAdmin(meta,this.ownIds)){
      await this.db.query('UPDATE groups SET is_admin=false,error=$2 WHERE id=$1',[id,'Connected account must be a group admin']);
      throw new Error('Connected account must be a group admin');
    }
    return meta;
  }
  async syncGroup(id) {
    const socket=this.require();
    const meta=await this.readMetadata(id);
    const pending=await retryRead(()=>socket.groupRequestParticipantsList(id));
    const client=await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM groups WHERE id=$1 FOR UPDATE',[id]);
      const snapshot=[...new Map(pending.filter(p=>p.jid).map(p=>[p.jid,p])).values()].map(p=>({jid:p.jid,requested_at:Number(p.request_time)>0?new Date(Number(p.request_time)*1000).toISOString():null}));
      if(snapshot.length)await client.query(`INSERT INTO requests(group_id,jid,requested_at)
        SELECT $1,p.jid,p.requested_at FROM jsonb_to_recordset($2::jsonb) AS p(jid text,requested_at timestamptz)
        ON CONFLICT(group_id,jid) DO UPDATE SET
          status=CASE WHEN requests.status IN ('gone','approved') THEN 'pending' ELSE requests.status END,
          first_seen=CASE WHEN requests.status IN ('gone','approved') THEN now() ELSE requests.first_seen END`,[id,JSON.stringify(snapshot)]);
      await client.query(`UPDATE requests SET status='gone' WHERE group_id=$1 AND status='pending' AND NOT(jid=ANY($2::text[]))`,[id,pending.map(p=>p.jid).filter(Boolean)]);
      await client.query('UPDATE groups SET baseline_at=COALESCE(baseline_at,now()),synced_at=now(),member_count=$2,is_admin=true,error=null WHERE id=$1',[id,meta.size??meta.participants.length]);
      await client.query('COMMIT');
    } catch(e){await client.query('ROLLBACK');throw e;} finally{client.release();}
    return meta;
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.retry = 0;
    ++this.generation;
    const socket = this.socket;
    this.socket = null;
    this.qr = null;
    this.state = 'disconnected';
    socket?.end(new Error('Service shutdown'));
    await Promise.allSettled(this.authOperations);
  }
}
