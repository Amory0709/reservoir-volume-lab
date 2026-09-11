import {mkdirSync,writeFileSync,openSync,writeSync,closeSync,fsyncSync,statSync} from 'node:fs';
import {resolve} from 'node:path';
import {makeExplicitGrid} from '../dist/explicit-grid.js';
import {vertexShader,explicitFragmentShader} from '../dist/explicit-shaders.js';
import {boundaryShader} from './boundary-shader.mjs';
const dir=process.argv[2],scale=process.argv[3]??'small';if(!dir)throw new Error('Provide scratch output directory');mkdirSync(dir,{recursive:true});
const v=makeExplicitGrid(scale,()=>{},scale==='small'?[20,12,10]:undefined);
const keys=['dims','nodeDims','splitsX','splitY','bounds','nodeCount','nodeWidth','nodeHeight','rangeHeight','stats'];
writeFileSync(resolve(dir,'metadata.json'),JSON.stringify(Object.fromEntries(keys.map(k=>[k,v[k]]))));
for(const key of ['vertices','attributes','nodes','ranges']){
  const file=resolve(dir,key+'.bin'),buffer=Buffer.from(v[key].buffer),fd=openSync(file,'w');
  try{let offset=0;while(offset<buffer.byteLength){const n=writeSync(fd,buffer,offset,Math.min(8*1024*1024,buffer.byteLength-offset),offset);if(!n)throw new Error('Incomplete binary write');offset+=n;}fsyncSync(fd);}finally{closeSync(fd);}
  if(statSync(file).size!==buffer.byteLength)throw new Error('Incomplete binary export: '+key);
}
writeFileSync(resolve(dir,'vertex.glsl'),vertexShader);writeFileSync(resolve(dir,'fragment.glsl'),explicitFragmentShader);
writeFileSync(resolve(dir,'boundary.glsl'),boundaryShader(explicitFragmentShader));
writeFileSync(resolve(dir,'alpha.glsl'),explicitFragmentShader.replaceAll('outColor=vec4(acc.rgb+(1.0-acc.a)*bg,1);','outColor=vec4(vec3(acc.a),1);').replaceAll('outColor=vec4(bg,1);','outColor=vec4(0,0,0,1);'));
console.log(v.stats);
