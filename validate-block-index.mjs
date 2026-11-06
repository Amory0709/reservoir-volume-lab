import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {makeExplicitGrid} from './dist/explicit-grid.js';
import {buildBlockIndex,blockIndexTransfers} from './dist/block-index.js';
function validate(v){
 const index=buildBlockIndex(v);assert(index);v.blockIndex=index;
 assert.equal(blockIndexTransfers(v).length,3);
 const owners=new Map();let references=0;
 for(let block=0;block<index.count;block++){
  const data=index.data.subarray(block*16,block*16+16),dims=[...data.subarray(8,11)],total=dims.reduce((a,b)=>a*b,1);
  for(let bin=0;bin<total;bin++){
   const o=(data[3]+bin)*2,start=index.ranges[o],count=index.ranges[o+1];assert(start+count<=index.leaves.length);
   for(let r=start;r<start+count;r++){const node=index.leaves[r];assert(v.nodes[node*8+7]>0);assert(v.ranges[node*2]<=v.ranges[node*2+1]);owners.set(node,block);references++;}
  }
 }
 for(let node=0;node<v.nodeCount;node++){
  const o=node*8;if(v.nodes[o+7]<=0||v.ranges[node*2]>v.ranges[node*2+1])continue;
  assert(owners.has(node),'Active leaf disappeared');
  const block=owners.get(node),data=index.data.subarray(block*16,block*16+16),dims=[...data.subarray(8,11)];
  for(let sample=0;sample<9;sample++){
   const bin=[];
   for(let a=0;a<3;a++){
    const point=sample===8?(v.nodes[o+a]+v.nodes[o+4+a])/2:v.nodes[o+((sample>>a)&1)*4+a];
    const spacing=Math.fround(Math.fround(data[4+a]-data[a])/dims[a]);
    bin[a]=Math.max(0,Math.min(dims[a]-1,Math.floor(Math.fround(Math.fround(point-data[a])/spacing))));
   }
   const r=(data[3]+(bin[2]*dims[1]+bin[1])*dims[0]+bin[0])*2;
   assert(index.leaves.subarray(index.ranges[r],index.ranges[r]+index.ranges[r+1]).includes(node),'Float32 boundary lost a leaf');
  }
 }
 console.log('PASS conservative block index',{blocks:index.count,leaves:owners.size,references,bytes:index.bytes});
 return index;
}
const synthetic=makeExplicitGrid('test',()=>{},[20,12,10]);assert.equal(validate(synthetic).count,8);
if(process.argv[2]){
 const root=process.argv[2],v=JSON.parse(await readFile(root+'/metadata.json'));
 for(const key of ['nodes','ranges','columnPillars','kInterfaces']){const b=await readFile(root+'/'+key+'.bin');v[key]=new (key==='nodes'||key==='ranges'?Float32Array:Uint32Array)(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));}
 validate(v);
}
for(let n=0;n<synthetic.nodeCount;n++){synthetic.ranges[n*2]=1;synthetic.ranges[n*2+1]=-1;}
assert.equal(buildBlockIndex(synthetic),null,'Empty volume allocated invalid textures');
