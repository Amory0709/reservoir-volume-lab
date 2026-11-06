import assert from 'node:assert/strict';
import {makeExplicitGrid} from './dist/explicit-grid.js';
import {attachBlockIndex} from './dist/block-index.js';
import {ExplicitVolumeRenderer} from './dist/explicit-renderer.js';
import {LargeVolumeRenderer} from './dist/large-renderer.js';
globalThis.window={devicePixelRatio:1};globalThis.cancelAnimationFrame=()=>{};
globalThis.ResizeObserver=class{observe(){}disconnect(){}};
for(const failureUnit of [-1,6,7,8]){
 const volume=makeExplicitGrid('test',()=>{},[20,12,10]);attachBlockIndex(volume);
 const originalBytes=volume.stats.gpuBytes,indexBytes=volume.blockIndex.bytes;
 let unit=0,error=0,nextConstant=1;const bindings=new Map(),constants=new Map();
 const functions={
  getParameter:()=>4096,getExtension:()=>null,getProgramParameter:()=>true,
  createShader:()=>({}),createProgram:()=>({}),createVertexArray:()=>({}),createTexture:()=>({}),fenceSync:()=>({}),
  activeTexture:u=>{unit=u-gl.TEXTURE0;},bindTexture:(_,texture)=>bindings.set(unit,texture),
  texImage3D:(_target,_level,_internal,w,h,d)=>{bindings.get(unit).size=[w,h,d];},
  texImage2D:(_target,_level,_internal,w,h)=>{
   bindings.get(unit).size=[w,h];
   if(unit===failureUnit&&w*h>1)error=gl.OUT_OF_MEMORY;
  },
  getError:()=>{const e=error;error=0;return e;},getUniformLocation:(_p,n)=>n,clientWaitSync:()=>gl.ALREADY_SIGNALED,isContextLost:()=>false
 };
 const gl=new Proxy(functions,{get:(target,key)=>{
  if(key==='NO_ERROR')return 0;if(key in target)return target[key];
  if(/^[A-Z0-9_]+$/.test(key)){if(!constants.has(key))constants.set(key,nextConstant++);return constants.get(key);}
  return ()=>{};
 }});
 // Texture units are consecutive constants, as in real GLES.
 constants.set('TEXTURE0',100);
 const canvas={getContext:()=>gl,addEventListener:()=>{},getBoundingClientRect:()=>({width:240,height:160})};
 const renderer=new ExplicitVolumeRenderer(canvas,volume,()=>{});renderer.afterTextureUpload=()=>{};
 await LargeVolumeRenderer.prototype.initialize.call(renderer);
 if(failureUnit>=0){
  assert.equal(renderer.blockCount,0);assert.equal(volume.stats.gpuBytes,originalBytes);
  for(let i=6;i<9;i++)assert.deepEqual(bindings.get(i).size,[1,1],'Optional OOM did not release all accelerator textures');
 }else{assert.equal(renderer.blockCount,8);assert.equal(volume.stats.gpuBytes,originalBytes+indexBytes);}
 assert.deepEqual(bindings.get(0).size,[...volume.nodeDims]);assert.deepEqual(bindings.get(1).size,[...volume.dims]);
 renderer.dispose();
}
console.log('PASS production upload: full index and all optional OOM positions preserve base geometry');
