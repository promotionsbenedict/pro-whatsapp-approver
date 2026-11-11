import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DisconnectReason } from '@whiskeysockets/baileys';
import { WhatsApp } from '../server/whatsapp.mjs';
import { Tenants } from '../server/tenants.mjs';

test('session reset drains old credentials and rejects stale QR results before pairing again', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'approver-pairing-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  const creds = join(dir, 'creds.json');
  const writeGate = Promise.withResolvers();
  const qrGate = Promise.withResolvers();
  const loaded = [];
  const sockets = [];
  const db = {query: async () => ({})};
  const log = async () => {};
  const wa = new WhatsApp(db, log, dir, {
    async loadAuth() {
      loaded.push(await readFile(creds, 'utf8').catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      }));
      return {
        state: {creds:{}, keys:{get:async()=>({}), set:async()=>{}}},
        async saveCreds() {
          await writeGate.promise;
          await writeFile(creds, 'old account');
        },
      };
    },
    makeSocket() {
      const socket = {ev:new EventEmitter(), end(){}};
      sockets.push(socket);
      return socket;
    },
    renderQr: value => value === 'old-qr' ? qrGate.promise : Promise.resolve(value),
  });
  const user = {id:'user'};
  const manager = new Tenants(db);
  manager.runtimes.set(user.id, {user, wa, log, authDir:dir, started:true});
  await wa.connect();
  const old = sockets[0];
  old.ev.emit('creds.update');
  old.ev.emit('connection.update', {qr:'old-qr'});
  const reset = manager.reset(user);
  const start = manager.start(user);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(wa.qr, null);
  assert.equal(sockets.length, 1);
  writeGate.resolve();
  await Promise.all([reset, start]);
  assert.deepEqual(loaded, [null, null]);
  sockets[1].ev.emit('connection.update', {qr:'fresh-qr'});
  await new Promise(resolve => setImmediate(resolve));
  qrGate.resolve('old-qr');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(wa.qr, 'fresh-qr');
  await wa.stop();
  assert.equal(wa.qr, null);
});

test('post-scan restart begins immediately and waits for credentials to persist', {timeout:1000}, async t => {
  const writeGate = Promise.withResolvers();
  const restarted = Promise.withResolvers();
  let persisted = false;
  let loads = 0;
  const sockets = [];
  const wa = new WhatsApp({}, async () => {}, '/unused', {
    renderQr: async value => value,
    async loadAuth() {
      if (++loads === 2) assert.equal(persisted, true);
      return {
        state:{creds:{}, keys:{get:async()=>({}), set:async()=>{}}},
        async saveCreds() {
          await writeGate.promise;
          persisted = true;
        },
      };
    },
    makeSocket() {
      const socket = {ev:new EventEmitter(), end(){}};
      sockets.push(socket);
      if (sockets.length === 2) restarted.resolve();
      return socket;
    },
  });
  t.after(() => wa.stop());
  await wa.connect();
  sockets[0].ev.emit('connection.update', {qr:'scan-me'});
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(wa.qr);
  sockets[0].ev.emit('creds.update');
  sockets[0].ev.emit('connection.update', {isNewLogin:true});
  assert.equal(wa.qr, null);
  sockets[0].ev.emit('connection.update', {
    connection:'close',
    lastDisconnect:{error:{output:{statusCode:DisconnectReason.restartRequired}}},
  });
  writeGate.resolve();
  await restarted.promise;
  assert.equal(loads, 2);
});
