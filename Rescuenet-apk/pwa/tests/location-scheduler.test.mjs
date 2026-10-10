import test from 'node:test';
import assert from 'node:assert/strict';
import { LocationScheduler } from '../location-scheduler.mjs';

const wait = () => new Promise(resolve => setImmediate(resolve));
function fixture(overrides = {}) {
  let pending = null, latest = null, accepted = null, now = 1_000_000;
  let isEnabled = true;
  const timers = new Map(); let timerId = 0; const sent = [];
  const scheduler = new LocationScheduler({
    readPending:()=>pending, writePending:value=>{pending=value;},
    readLatest:()=>latest, writeLatest:value=>{latest=value;},
    readLastAccepted:()=>accepted, writeLastAccepted:value=>{accepted=value;},
    makePacket:fix=>({request_id:`r-${fix.timestamp}`,timestamp:Math.floor(fix.timestamp/1000),lat:fix.lat,lon:fix.lon}),
    send:async packet=>{sent.push(packet);return {node_id:1};},
    enabled:()=>isEnabled,onState:()=>{},now:()=>now,
    setTimer:(fn,delay)=>{const id=++timerId;timers.set(id,{fn,delay});return id;},clearTimer:id=>timers.delete(id),
    ...overrides,
  });
  return {scheduler,get pending(){return pending;},get latest(){return latest;},get accepted(){return accepted;},get timers(){return timers;},sent,advance:ms=>{now+=ms;},setEnabled:value=>{isEnabled=value;}};
}
const fix=(timestamp,lat=-6.2)=>({timestamp,lat,lon:106.8,accuracy:8});

test('GPS fix baru saat request in-flight dicoalesce, ACK lama tidak menghapus fix terbaru',async()=>{
  let release;let calls=0;
  const f=fixture({send:packet=>{calls++;if(calls===1)return new Promise(resolve=>{release=()=>resolve({node_id:2});});return Promise.resolve({node_id:2});}});
  f.scheduler.offer(fix(1_000_000));
  await wait();
  f.advance(120_000);
  f.scheduler.offer(fix(1_120_000,-6.21));
  assert.equal(f.pending.packet.request_id,'r-1000000');
  release();
  await wait();await wait();
  assert.equal(calls,2);
  assert.equal(f.accepted.lat,-6.21);
  assert.equal(f.pending,null);
});

test('fix baru tidak mereset retry ID, attempt, atau deadline backoff',async()=>{
  const f=fixture({send:async()=>{throw new Error('offline');}});
  f.scheduler.offer(fix(1_000_000));await wait();
  const first={...f.pending};
  f.advance(120_000);
  f.scheduler.offer(fix(1_120_000,-6.21));
  assert.equal(f.pending.packet.request_id,first.packet.request_id);
  assert.equal(f.pending.attempts,1);
  assert.equal(f.pending.nextAttemptAt,first.nextAttemptAt);
  assert.equal(f.timers.size,1);
});

test('foreground resume retries the preserved request after an in-flight lifecycle stop',async()=>{
  let release;let calls=0;
  const f=fixture({send:packet=>{calls++;if(calls===1)return new Promise(resolve=>{release=()=>resolve({node_id:3});});return Promise.resolve({node_id:3});}});
  f.scheduler.offer(fix(1_000_000));await wait();
  f.setEnabled(false);f.scheduler.stop();
  f.setEnabled(true);f.scheduler.resume();
  release();await wait();await wait();
  assert.equal(calls,2);
  assert.equal(f.pending,null);
  assert.equal(f.accepted.requestId,'r-1000000');
});

test('retry berhenti setelah lima percobaan dan tidak membuat timer tanpa batas',async()=>{
  const f=fixture({send:async()=>{throw new Error('offline');}});
  f.scheduler.offer(fix(1_000_000));
  for(let attempt=1;attempt<=5;attempt++){
    await wait();
    assert.equal(f.pending.attempts,attempt);
    if(attempt<5){
      const [id,timer]=f.timers.entries().next().value;f.timers.delete(id);f.advance(timer.delay);timer.fn();
    }
  }
  await wait();
  assert.equal(f.pending.attempts,5);
  assert.equal(f.timers.size,0);
});
