import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {makeExplicitGrid,cornerOffset,FACES} from './dist/explicit-grid.js';
import {compactSurfaceInput,buildSurfaceFaces,buildSectionCells,surfaceFilterKey,surfaceKey} from './dist/surface-cache.js';
import {surfaceVertexShader,surfaceFragmentShader,surfaceBackgroundShader,surfaceTransparentFragmentShader,surfaceResolveShader} from './dist/surface-shaders.js';
const output=process.argv[2]??'/tmp/reservoir-surface-validation';await mkdir(output,{recursive:true});
const cases=[['all',{porosityFilter:false,porosityMin:0,porosityMax:100,clipAxis:0,clip:0}],['phi',{porosityFilter:true,porosityMin:18,porosityMax:25,clipAxis:0,clip:0}],...['x','y','z'].map((n,i)=>['cut-'+n,{porosityFilter:true,porosityMin:18,porosityMax:25,clipAxis:i+1,clip:38}]),['empty',{porosityFilter:true,porosityMin:100,porosityMax:100,clipAxis:0,clip:0}]];
let v;
if(process.argv[3]){
 const root=process.argv[3];v=JSON.parse(await readFile(root+'/metadata.json','utf8'));
 for(const k of ['vertices','attributes','nodes','columnPillars','kInterfaces']){try{const b=await readFile(root+'/'+k+'.bin');v[k]=new (['columnPillars','kInterfaces'].includes(k)?Uint32Array:Float32Array)(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));}catch(e){if(!['columnPillars','kInterfaces'].includes(k))throw e;}}
}else v=makeExplicitGrid('test',()=>{},[24,20,12]);
const input=await compactSurfaceInput(v),[nx,ny,nz]=v.dims,offsets=[-nx*ny,nx*ny,-nx,nx,-1,1];
for(const [name,s] of cases){
 const packed=await buildSurfaceFaces(input,surfaceFilterKey(s,v));
 const expected=[];
 for(let k=0;k<nz;k++)for(let j=0;j<ny;j++)for(let i=0;i<nx;i++){
  const id=(k*ny+j)*nx+i;if(!packed.selected[id])continue;
  for(let f=0;f<6;f++){
   const next=[i,j,k];next[[2,2,1,1,0,0][f]]+=(f&1)?1:-1;
   let shared=false;
   if(next.every((n,a)=>n>=0&&n<v.dims[a])&&packed.selected[id+offsets[f]]){
    // Independently compare the actual four corner offsets on each face.
    const a=[...new Set(FACES.slice(f*2,f*2+2).flat())].map(c=>cornerOffset(v,i,j,k,c)).sort((a,b)=>a-b);
    const g=f^1,b=[...new Set(FACES.slice(g*2,g*2+2).flat())].map(c=>cornerOffset(v,...next,c)).sort((a,b)=>a-b);
    shared=a.every((p,c)=>p===b[c]);
   }
   if(!shared)expected.push(id*8+f);
  }
 }
 assert(packed.faces.length<=input.phi.length);
 const decoded=[];let offset=0;
 for(let n=1;n<=6;n++)for(let i=0;i<packed.groups[n-1];i++){
  const code=packed.faces[offset++],id=Math.floor(code/64),mask=code%64;let bits=0;
  for(let f=0;f<6;f++)if(mask&(1<<f)){decoded.push(id*8+f);bits++;}
  assert.equal(bits,n,'Packed group submits non-existent faces');
 }
 assert.equal(offset,packed.faces.length);assert.deepEqual(decoded.sort((a,b)=>a-b),expected,'Packed cache lost topology');
 assert.equal(packed.faceCount,expected.length);
 const a=Math.max(0,s.clipAxis-1),p=Math.fround(v.bounds.max[a]-(v.bounds.max[a]-v.bounds.min[a])*s.clip/100);
 const cap=await buildSectionCells(input,packed.selected,s.clipAxis,p);
 const ids=new Set(Array.from(cap.caps,code=>Math.floor(code/8)));
 if(s.clipAxis)for(let id=0;id<packed.selected.length;id++)if(packed.selected[id]){
  const i=id%nx,j=Math.floor(id/nx)%ny,k=Math.floor(id/(nx*ny)),coords=Array.from({length:8},(_,c)=>v.vertices[cornerOffset(v,i,j,k,c)+a]);
  if(Math.min(...coords)<=p&&Math.max(...coords)>=p)assert(ids.has(id),'Section candidate omitted');
 }
 const codes=new Uint32Array(expected.length+cap.caps.length);codes.set(expected);codes.set(cap.caps,expected.length);
 await writeFile(output+'/'+name+'.bin',new Uint8Array(codes.buffer));
 const packedCodes=new Uint32Array(packed.faces.length+cap.caps.length);packedCodes.set(packed.faces);packedCodes.set(cap.caps,packed.faces.length);
 await writeFile(output+'/'+name+'-packed.bin',new Uint8Array(packedCodes.buffer));
 await writeFile(output+'/'+name+'-groups.json',JSON.stringify([...packed.groups,cap.caps.length]));
 console.log('PASS',name,{faces:expected.length,sectionCandidates:cap.caps.length,cpuBytes:input.cpuBytes});
}
assert.equal(await buildSurfaceFaces(input,'all',()=>true),null,'Cancelled work must not complete');
assert.equal(surfaceKey(cases[0][1],v),'all|none');
await writeFile(output+'/cases.json',JSON.stringify(cases));
for(const [name,source] of [['surface-vertex.glsl',surfaceVertexShader],['surface-fragment.glsl',surfaceFragmentShader],['surface-background.glsl',surfaceBackgroundShader],['surface-transparent.glsl',surfaceTransparentFragmentShader],['surface-resolve.glsl',surfaceResolveShader]])await writeFile(output+'/'+name,source);
console.log('PASS bounded cache, cancellation, exact topology, shaders exported',output);
