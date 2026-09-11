import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {countExplicitMatches,cornerOffset,CORNERS} from './dist/explicit-grid.js';
const entry=new URL('./dist/explicit-worker.js',import.meta.url).href;
const source=`import {parentPort} from 'node:worker_threads';globalThis.self={postMessage:(m,t)=>parentPort.postMessage(m,t)};await import(${JSON.stringify(entry)});parentPort.on('message',data=>self.onmessage({data}));parentPort.postMessage({type:'boot'});`;
const v=await new Promise((resolve,reject)=>{
  const worker=new Worker(new URL('data:text/javascript,'+encodeURIComponent(source)));
  worker.on('error',reject);worker.on('message',m=>{
    if(m.type==='boot')worker.postMessage({scale:process.argv[2]??'explicit-1m'});
    if(m.type==='error'){worker.terminate();reject(new Error(m.message));}
    if(m.type==='ready'){worker.terminate();resolve(m.volume);}
  });
});
const [nx,ny,nz]=v.dims,count=nx*ny*nz;
assert.equal(v.attributes.length,count*4);assert.equal(v.stats.cells,count);
assert.equal(v.stats.activeCells+v.stats.inactiveCells,count);assert(v.stats.inactiveCells>0);
let active=0,distinct=0;
for(let i=0;i<count;i++){assert(v.attributes[i*4+3]===0||v.attributes[i*4+3]===1);active+=v.attributes[i*4+3];}
assert.equal(active,v.sortedPhi.length);
for(let i=1;i<v.sortedPhi.length;i++){assert(v.sortedPhi[i]>=v.sortedPhi[i-1]);distinct+=v.sortedPhi[i]>v.sortedPhi[i-1];}
assert(distinct>10000,'Float32 values were quantized');
for(const [lo,hi] of [[8,32],[18,25],[24,32],[18.123,18.127],[32,32],[18.2,18.2]]){
  let expected=0;for(let i=0;i<count;i++)if(v.attributes[i*4+3]&&v.attributes[i*4+1]>=Math.fround(lo/100)&&v.attributes[i*4+1]<=Math.fround(hi/100))expected++;
  assert.equal(countExplicitMatches(v,{porosityFilter:true,porosityMin:lo,porosityMax:hi}),expected);
}
assert.equal(countExplicitMatches(v,{porosityFilter:false}),active);
const sub=(a,b)=>a.map((x,i)=>x-b[i]),cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);
const tets=[[0,1,2,6],[0,2,3,6],[0,3,7,6],[0,7,4,6],[0,4,5,6],[0,5,1,6]];
for(let n=0;n<5000;n++){
  const id=Math.floor(n/5000*count),i=id%nx,j=Math.floor(id/nx)%ny,k=Math.floor(id/(nx*ny));
  const p=CORNERS.map((_,c)=>Array.from(v.vertices.slice(cornerOffset(v,i,j,k,c),cornerOffset(v,i,j,k,c)+3)));
  for(const [a,b,c,d] of tets)assert(dot(sub(p[b],p[a]),cross(sub(p[c],p[a]),sub(p[d],p[a])))>0,'Inverted cell');
  if(i<nx-1&&!v.splitsX.includes(i+1))assert.equal(cornerOffset(v,i,j,k,1),cornerOffset(v,i+1,j,k,0),'Unshared interior face');
}
for(const i of v.splitsX)assert.notEqual(cornerOffset(v,i-1,1,1,1),cornerOffset(v,i,1,1,0),'Fault nodes were merged');
assert.notEqual(cornerOffset(v,1,v.splitY-1,1,3),cornerOffset(v,1,v.splitY,1,0),'Y fault nodes were merged');
for(let id=0;id<v.nodeCount;id++){
  const o=id*8,escape=v.nodes[o+3];assert(escape>id&&escape<=v.nodeCount);
  if(v.ranges[id*2]>v.ranges[id*2+1])continue;
  if(v.nodes[o+7]===0){
    for(const child of [id+1,v.nodes[(id+1)*8+3]]){
      if(v.ranges[child*2]>v.ranges[child*2+1])continue;
      for(let a=0;a<3;a++){assert(v.nodes[child*8+a]>=v.nodes[o+a]);assert(v.nodes[child*8+4+a]<=v.nodes[o+4+a]);}
    }
  }
}
console.log('PASS worker transfer, Float32 counts, split topology, sampled positive tetrahedra and complete BVH bounds',v.stats);
