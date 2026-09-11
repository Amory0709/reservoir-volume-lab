import assert from 'node:assert/strict';
import {LatestRenderQueue} from './dist/render-queue.js';
const pendingFences=[],chunks=[];let running=0,peak=0;
const queue=new LatestRenderQueue(async(job,cancelled)=>{
  running++;peak=Math.max(peak,running);
  try{for(let i=0;i<4;i++){
    if(cancelled())return false;
    chunks.push([job,i]);await new Promise(resolve=>pendingFences.push(resolve));
  }return true;}finally{running--;}
});
const first=queue.request('old');assert.equal(chunks.length,1);
const burst=[];for(let i=0;i<100;i++)burst.push(queue.request(i));
assert.equal(chunks.length,1,'Queued work bypassed in-flight GPU fence');
pendingFences.shift()();await new Promise(setImmediate);
assert.deepEqual(chunks,[['old',0],[99,0]],'Stale frames were rendered');
for(let i=0;i<4;i++){pendingFences.shift()();await new Promise(setImmediate);}
assert.equal(await first,false);assert.deepEqual(await Promise.all(burst),Array.from({length:100},(_,i)=>i===99));
assert.equal(peak,1);assert.equal(queue.running,false);
const stopped=queue.request('disposed');queue.dispose();pendingFences.shift()();await new Promise(setImmediate);
assert.equal(await stopped,false);assert.equal(await queue.request('late'),false);
assert.equal(chunks.filter(c=>c[0]==='disposed').length,1);
let failed=true;
const recover=new LatestRenderQueue(async()=>{if(failed){failed=false;throw new Error('GPU failure');}return true;});
await assert.rejects(recover.request(1),/GPU failure/);assert.equal(await recover.request(2),true);
console.log('PASS: 100 rapid requests coalesced, one in-flight producer, cancelled after fence, disposal and error recovery');
