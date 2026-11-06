// Deliberately fragmented filter: half the cells are isolated, so the old
// 4M-face cache would overflow well before either supported model size.
import assert from 'node:assert/strict';
import {buildSurfaceFaces,buildSectionCells} from './dist/surface-cache.js';
for(const dims of [[400,250,100],[500,400,100]]){
 const [nx,ny,nz]=dims,count=nx*ny*nz,phi=new Float32Array(count),active=new Uint8Array(count);active.fill(1);
 for(let id=0;id<count;id++)phi[id]=(id%nx+Math.floor(id/nx)%ny+Math.floor(id/(nx*ny)))%2?.3:.2;
 const input={dims,phi,active,splitsX:[],splitY:-1,groups:dims.map(n=>Math.ceil(n/2))};
 const start=performance.now(),cache=await buildSurfaceFaces(input,`${Math.fround(.19)}:${Math.fround(.21)}`);
 assert.equal(cache.faceCount,count*3);assert.equal(cache.faces.length,count/2);
 assert.deepEqual(cache.groups,[0,0,0,0,0,count/2]);
 let offset=0;
 for(let id=0;id<count;id++)if(cache.selected[id])assert.equal(cache.faces[offset++],id*64+63,'Fragmented cell lost a face');
 // Conservative leaf bounds may overlap a section in highly deformed grids.
 // Verify that more than 1M candidates remain complete instead of falling back.
 input.boxes=new Float32Array(input.groups.reduce((a,b)=>a*b,1)*6);
 for(let i=0;i<input.boxes.length;i+=6){input.boxes[i+2]=-1;input.boxes[i+5]=1;}
 const section=await buildSectionCells(input,cache.selected,3,0);
 assert.equal(section.caps.length,count/2);
 const seen=new Uint8Array(count);
 for(const code of section.caps){const id=Math.floor(code/8);assert.equal(code%8,6);assert(cache.selected[id]&&!seen[id]);seen[id]=1;}
 console.log('PASS fragmented capacity',{cells:count,faces:cache.faceCount,boundaryIndexBytes:cache.faces.byteLength,sectionCandidates:section.caps.length,elapsedMs:Math.round(performance.now()-start)});
}
