/**
 * A call log you can actually read.
 *
 * Deliberately a JSON file, not a database. You can open calls.json in any text
 * editor after a test call and see exactly what the agent heard and did, which
 * is the fastest way to work out why it behaved oddly. Swap this for Postgres
 * when you have more traffic than a file can take — nothing else imports the
 * file path, only these four functions.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = join(dirname(dirname(fileURLToPath(import.meta.url))), 'calls.json');

function readAll() {
  if (!existsSync(FILE)) return [];
  try {
    return JSON.parse(readFileSync(FILE, 'utf8'));
  } catch {
    // A half-written file should not take the phone line down.
    console.warn('[store] calls.json is unreadable — starting a fresh log.');
    return [];
  }
}

function writeAll(rows) {
  writeFileSync(FILE, JSON.stringify(rows, null, 2));
}

export function startCall({ callSid, from, to }) {
  const rows = readAll();
  rows.push({
    callSid,
    from,
    to,
    startedAt: new Date().toISOString(),
    endedAt: null,
    transcript: [],
    booking: null,
    message: null,
  });
  writeAll(rows);
}

function update(callSid, mutate) {
  const rows = readAll();
  const row = rows.find((r) => r.callSid === callSid);
  if (!row) return;
  mutate(row);
  writeAll(rows);
}

export function addTurn(callSid, speaker, text) {
  if (!text || !text.trim()) return;
  update(callSid, (row) => row.transcript.push({ speaker, text: text.trim(), at: new Date().toISOString() }));
}

export function recordBooking(callSid, booking) {
  update(callSid, (row) => { row.booking = booking; });
}

export function recordMessage(callSid, message) {
  update(callSid, (row) => { row.message = message; });
}

export function endCall(callSid) {
  update(callSid, (row) => { row.endedAt = new Date().toISOString(); });
}

export function recentCalls(limit = 20) {
  return readAll().slice(-limit).reverse();
}
