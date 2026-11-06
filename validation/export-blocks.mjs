import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {buildBlockIndex} from '../dist/block-index.js';
import {withBlockTraversal} from '../dist/block-shader.js';
import {explicitFragmentShader} from '../dist/explicit-shaders.js';
const [fixture,out]=process.argv.slice(2);await mkdir(out,{recursive:true});
const v=JSON.parse(await readFile(fixture+'/metadata.json'));
for(const key of ['nodes','ranges',...(v.synthetic===false?['columnPillars','kInterfaces']:[])]){
 const b=await readFile(fixture+'/'+key+'.bin');v[key]=new (['nodes','ranges'].includes(key)?Float32Array:Uint32Array)(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));
}
const index=buildBlockIndex(v,()=>{},Number(process.env.BIN_FACTOR??1));if(!index)throw new Error('Index allocation limit');
for(const key of ['data','ranges','leaves'])await writeFile(out+'/'+key+'.bin',new Uint8Array(index[key].buffer));
await writeFile(out+'/index.json',JSON.stringify({count:index.count,bytes:index.bytes,buildMs:index.buildMs}));
await writeFile(out+'/fragment.glsl',withBlockTraversal(explicitFragmentShader));
console.log({count:index.count,bytes:index.bytes,buildMs:index.buildMs});
