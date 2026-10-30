export const HARD_CAP = 1024;
export function freeSlots(metadata, configured = HARD_CAP) {
  const size = Number(metadata.size ?? metadata.participants?.length);
  if (!Number.isInteger(size) || size < 0) throw new Error('WhatsApp did not return a valid member count');
  return Math.max(0, Math.min(HARD_CAP, Number(configured) || HARD_CAP) - size);
}
export function parseTarget(kind, amount, available) {
  if (!['all','custom','auto'].includes(kind)) throw new Error('Invalid approval mode');
  if (kind === 'all' || kind === 'auto') return available;
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 100000) throw new Error('Enter a whole number from 1 to 100,000');
  if (amount > available) throw new Error(`Only ${available} pending requests are available`);
  return amount;
}
export function participantMatches(p,jid) { return [p.id,p.lid,p.phoneNumber].filter(Boolean).includes(jid); }
export function isAdmin(metadata, ownIds) {
  return metadata.participants?.some(p => ownIds.some(id => participantMatches(p,id)) && ['admin','superadmin'].includes(p.admin)) ?? false;
}
export function confirmedOutcome(response, jid, metadata) {
  const result = response?.find(r => r.jid === jid);
  const joined = metadata.participants?.some(p => participantMatches(p,jid));
  if (String(result?.status) === '200' && joined) return 'confirmed';
  if (String(result?.status) === '200') return 'uncertain';
  if (result && !joined && ['403','404','406','409'].includes(String(result.status))) return 'rejected';
  return 'uncertain';
}
