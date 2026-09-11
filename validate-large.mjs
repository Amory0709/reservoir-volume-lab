import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {LARGE_SCALES,largePorosityRange,countLargeMatches} from './dist/large-grid.js';
const entry=new URL('./dist/large-worker.js',import.meta.url).href;
function generate(scale){
  const source=`import {parentPort} from 'node:worker_threads';globalThis.self={postMessage:(message,transfer)=>parentPort.postMessage(message,transfer)};await import(${JSON.stringify(entry)});parentPort.on('message',data=>self.onmessage({data}));parentPort.postMessage({type:'boot'});`;
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('data:text/javascript,'+encodeURIComponent(source)));
    worker.on('error',reject);
    worker.on('message',message=>{
      if(message.type==='boot')worker.postMessage({scale});
      if(message.type==='error'){worker.terminate();reject(new Error(message.message));}
      if(message.type==='ready'){worker.terminate();resolve(message.volume);}
    });
  });
}
for(const [scale,dims] of Object.entries(LARGE_SCALES)){
  const volume=await generate(scale),count=dims.reduce((a,b)=>a*b,1);
  assert.equal(volume.stats.cells,count);assert.equal(volume.attributes.length,count*4);
  assert.equal(volume.histogram.reduce((a,b)=>a+b,0),count);
  for(const axis of volume.axes)for(let i=1;i<axis.length;i++)assert(axis[i]>axis[i-1],'Inverted/degenerate coordinate interval');
  for(const [min,max] of [[8,32],[18,25],[24,32],[32,32]]){
    let expected=0;
    for(let cell=0;cell<count;cell++){const phi=8+24*volume.attributes[cell*4+1]/255;if(phi>=min&&phi<=max)expected++;}
    assert.equal(countLargeMatches(volume,{porosityFilter:true,porosityMin:min,porosityMax:max}),expected);
  }
  const [nx,ny,nz]=dims,[bx,by,bz]=volume.coarse;
  for(let n=0;n<997;n++){
    const index=Math.floor(n/997*count),i=index%nx,j=Math.floor(index/nx)%ny,k=Math.floor(index/(nx*ny));
    const brick=((Math.floor(k/10)*by+Math.floor(j/10))*bx+Math.floor(i/10))*4,phi=volume.attributes[index*4+1];
    assert(phi>=volume.bricks[brick]&&phi<=volume.bricks[brick+1],'Brick bound excludes a stored cell');
  }
  assert.equal(countLargeMatches(volume,{porosityFilter:false}),count);
  console.log('PASS',scale,{cells:count,gpuBytes:volume.stats.gpuBytes,generationMs:Math.round(volume.stats.generationMs),workerTransfer:true});
}
assert.deepEqual(largePorosityRange(8,32),[0,255]);
assert.deepEqual(largePorosityRange(18,25),[107,180]);
