import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {makeExplicitGrid} from './dist/explicit-grid.js';
const source=new URL('./dist/surface-worker.js',import.meta.url).href;
const worker=new Worker(new URL('data:text/javascript,'+encodeURIComponent(`import {parentPort} from 'node:worker_threads';globalThis.self={postMessage:(data,transfer)=>parentPort.postMessage(data,transfer)};await import(${JSON.stringify(source)});parentPort.on('message',data=>self.onmessage({data}));`)),{type:'module'});
const messages=[],waiters=[];
worker.on('message',m=>{messages.push(m);for(const w of [...waiters])if(w.test(m)){clearTimeout(w.timer);waiters.splice(waiters.indexOf(w),1);w.resolve(m);}});
const wait=test=>new Promise((resolve,reject)=>{const w={test,resolve};w.timer=setTimeout(()=>reject(new Error('Worker timeout')),10000);waiters.push(w);});
try{
 const v=makeExplicitGrid('worker',()=>{},[100,80,40]);
 const originalPhi=Float32Array.from({length:v.stats.cells},(_,id)=>v.attributes[id*4+1]);
 const volume={dims:v.dims,nodeCount:v.nodeCount,splitsX:v.splitsX,splitY:v.splitY,attributes:v.attributes,nodes:v.nodes};
 const initialized=wait(m=>m.type==='initialized');worker.postMessage({type:'init',volume},[v.attributes.buffer,v.nodes.buffer]);
 assert.equal(v.attributes.byteLength,0);assert.equal(v.nodes.byteLength,0);
 await initialized;
 const latest=wait(m=>m.type==='surface'&&m.key==='latest');
 for(let n=0;n<100;n++)worker.postMessage({type:'build',key:n===99?'latest':'obsolete'+n,filterKey:n===99?'all':`${Math.fround(.18+n*.00001)}:${Math.fround(.25)}`,axis:n===99?3:0,position:0});
 const result=await latest;assert(result.faces instanceof Uint32Array&&result.faces.length>0);assert(result.caps.length>0);
 assert.equal(result.groups.reduce((a,b)=>a+b,0),result.faces.length);assert(result.faceCount>result.faces.length);
 assert.equal(messages.filter(m=>m.type==='surface').length,1,'Obsolete rebuild completed after latest request');
 const clipOnly=wait(m=>m.type==='surface'&&m.key==='clip-only');worker.postMessage({type:'build',key:'clip-only',filterKey:'all',axis:0,position:0});
 const next=await clipOnly;assert.deepEqual(next.faces,result.faces,'Transferred face cache was lost on clip update');assert.equal(next.caps.length,0);
 assert(!messages.some(m=>m.type==='error'));
 console.log('PASS actual surface Worker: input transfers, latest request, cancellation, cached filter reuse, section candidates, output transfers');
 worker.postMessage({type:'compare'});
 const leftReady=wait(m=>m.type==='surface'&&m.lane==='volume'&&m.key==='left-latest');
 const rightReady=wait(m=>m.type==='surface'&&m.lane==='surface'&&m.key==='right-stable');
 worker.postMessage({type:'build',lane:'surface',key:'right-stable',filterKey:`${Math.fround(.24)}:${Math.fround(.30)}`,axis:1,position:0});
 for(let i=0;i<50;i++)worker.postMessage({type:'build',lane:'volume',key:i===49?'left-latest':'left-old-'+i,filterKey:`${Math.fround(.18)}:${Math.fround(.22)}`,axis:3,position:0});
 const [left,right]=await Promise.all([leftReady,rightReady]);
 for(const [output,lo,hi] of [[left,.18,.22],[right,.24,.30]]){
  assert(output.faces.length>0&&output.caps.length>0);
  for(const code of output.faces){const phi=originalPhi[Math.floor(code/64)];assert(phi>=Math.fround(lo)&&phi<=Math.fround(hi),'Another pane changed the filter cache');}
 }
 const rightClip=wait(m=>m.type==='surface'&&m.lane==='surface'&&m.key==='right-clip');
 worker.postMessage({type:'build',lane:'surface',key:'right-clip',filterKey:`${Math.fround(.24)}:${Math.fround(.30)}`,axis:0,position:0});
 const reused=await rightClip;assert.deepEqual(reused.faces,right.faces);assert.equal(reused.caps.length,0);
 assert(!messages.some(m=>m.type==='error'));
 console.log('PASS dual surface Worker: one input, independent cancellation, distinct property filters and retained per-pane cache');
}finally{for(const w of waiters)clearTimeout(w.timer);await worker.terminate();}
