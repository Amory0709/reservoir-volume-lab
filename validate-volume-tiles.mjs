import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {volumeTiles,volumePatch} from './dist/volume-tiles.js';
for(const [w,h] of [[1,1],[1,409],[409,1],[257,129],[641,397],[2000,1000]]){
  const coverage=new Uint8Array(w*h);let budget=1024,index=0;
  for(const tile of volumeTiles(w,h,()=>budget)){
    assert(tile.w>0&&tile.h>0&&tile.w*tile.h<=65536);
    assert(tile.x>=0&&tile.y>=0&&tile.x+tile.w<=w&&tile.y+tile.h<=h);
    if(!index){assert(Math.abs(tile.x-w/2)<=256);assert(Math.abs(tile.y-h/2)<=256);}
    for(let y=tile.y;y<tile.y+tile.h;y++)for(let x=tile.x;x<tile.x+tile.w;x++)assert.equal(coverage[y*w+x]++,0,'Overlapping tiles');
    const p=volumePatch(tile,w,h,Math.ceil(w*1.37),Math.ceil(h*1.37));
    assert(p.x>=0&&p.y>=0&&p.w>0&&p.h>0&&p.x+p.w<=Math.ceil(w*1.37)&&p.y+p.h<=Math.ceil(h*1.37));
    budget=[65536,256,4096,512,16384][index++%5];
  }
  assert(coverage.every(v=>v===1),'Missing pixels');
}
if(process.argv[2]){
  const width=53,height=41,displayWidth=96,displayHeight=72;let budget=256;
  const tiles=[];for(const tile of volumeTiles(width,height,()=>budget)){tiles.push({...tile,patch:volumePatch(tile,width,height,displayWidth,displayHeight)});budget=Math.min(512,budget*1.15);}
  await writeFile(process.argv[2],JSON.stringify({width,height,displayWidth,displayHeight,tiles}));
}
console.log('PASS center-first adaptive tiles: every pixel exactly once, bounded batches and scaled patch coverage');
