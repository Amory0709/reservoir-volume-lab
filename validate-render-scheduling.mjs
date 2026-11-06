// Production renderer with a deliberately delayed GPU fence; no browser/DOM.
import assert from 'node:assert/strict';
import {ExplicitVolumeRenderer} from './dist/explicit-renderer.js';
import {surfaceKey} from './dist/surface-cache.js';
import {SurfaceRaster} from './dist/surface-raster.js';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
globalThis.window={devicePixelRatio:1};globalThis.requestAnimationFrame=f=>setTimeout(()=>f(performance.now()),0);globalThis.cancelAnimationFrame=clearTimeout;
let inFlight=0,peak=0,draws=0,presented=0,drawTarget=null,readTarget=null,lastSubmittedFrame=null,texture=null,scissor=null,gpuDelay=0,scissorEnabled=false,fullCopies=0,seedCopies=0;
let activeUnit=0;const bindings=new Map();
const uniforms={},frames=[],events=[],errors=[],started=[],patches=[];
const until=async predicate=>{const deadline=performance.now()+5000;while(!predicate()&&performance.now()<deadline)await pause(2);assert(predicate(),'Renderer did not complete');};
const gl={TEXTURE0:0,TEXTURE_2D:200,NO_ERROR:0,FRAMEBUFFER_COMPLETE:1,TIMEOUT_EXPIRED:2,CONDITION_SATISFIED:3,ALREADY_SIGNALED:4,WAIT_FAILED:5,
  FRAMEBUFFER:10,DRAW_FRAMEBUFFER:11,READ_FRAMEBUFFER:12,SCISSOR_TEST:13,
  createTexture:()=>({}),createFramebuffer:()=>({pixels:0}),deleteTexture:()=>{},deleteFramebuffer:f=>{f.deleted=true;},
  activeTexture:unit=>{activeUnit=unit;},bindTexture:(_,t)=>{texture=t;bindings.set(activeUnit,t);},texParameteri:()=>{},texImage2D:(_a,_b,_c,w,h)=>{texture.width=w;texture.height=h;},
  bindFramebuffer:(target,f)=>{if(target===10||target===11)drawTarget=f;if(target===10||target===12)readTarget=f;},
  framebufferTexture2D:()=>{Object.assign(drawTarget,{width:texture.width,height:texture.height,coverage:new Uint8Array(texture.width*texture.height),tiles:0});},checkFramebufferStatus:()=>1,
  uniform3fv:(k,v)=>{uniforms[k]=[...v];},uniform3iv:()=>{},uniform1i:(k,v)=>{uniforms[k]=v;},uniform1f:()=>{},uniform2f:(k,a,b)=>{uniforms[k]=[a,b];},
  viewport:()=>{},useProgram:()=>{},bindVertexArray:()=>{},enable:cap=>{if(cap===13)scissorEnabled=true;},disable:cap=>{if(cap===13)scissorEnabled=false;},scissor:(x,y,w,h)=>{scissor=[x,y,w,h];},
  drawArrays:()=>{
    for(let unit=6;unit<9;unit++)assert.equal(bindings.get(unit),renderer.textures[unit],'Surface or target replaced a spatial index binding');
    assert.equal(inFlight,0,'Renderer submitted work before previous fence');assert(drawTarget&&!drawTarget.deleted);
    const [x,y,w,h]=scissor;assert(x>=0&&y>=0&&x+w<=drawTarget.width&&y+h<=drawTarget.height);assert(w*h<=65536,'GPU batch exceeded its cap');
    for(let row=y;row<y+h;row++){
      const offset=row*drawTarget.width+x;assert(!drawTarget.coverage.subarray(offset,offset+w).some(Boolean),'Adaptive tiles overlap');drawTarget.coverage.fill(1,offset,offset+w);
    }
    if(!drawTarget.tiles)drawTarget.viewStamp=renderer.surfaceViewStamp();drawTarget.tiles++;
    draws++;drawTarget.pixels+=scissor[2]*scissor[3];drawTarget.phi=[...uniforms.uPhi];drawTarget.preview=uniforms.uSurfacePreview;drawTarget.edges=!!uniforms.uEdges;
    lastSubmittedFrame=drawTarget;
  },
  blitFramebuffer:()=>{
    if(drawTarget){
      assert(readTarget&&!readTarget.deleted&&readTarget.pixels===readTarget.width*readTarget.height,'Progressive base is not complete');
      assert.equal(readTarget.viewStamp,renderer.surfaceViewStamp(),'Progressive base uses an old camera/style');
      drawTarget.initialized=true;seedCopies++;return;
    }
    if(scissorEnabled){
      assert.equal(inFlight,0,'Presented a tile before its fence completed');
      assert(readTarget?.initialized&&!readTarget.deleted,'Partial image sampled undefined memory');
      assert.equal(readTarget.viewStamp,renderer.surfaceViewStamp(),'Obsolete camera/style patch was presented');
      assert(scissor[0]>=0&&scissor[1]>=0&&scissor[0]+scissor[2]<=canvas.width&&scissor[1]+scissor[3]<=canvas.height);
      patches.push({target:readTarget,pixels:readTarget.pixels,total:readTarget.width*readTarget.height,region:[...scissor],time:performance.now()});return;
    }
    fullCopies++;
    assert(readTarget&&!readTarget.deleted);assert.equal(readTarget.pixels,readTarget.width*readTarget.height,'Incomplete frame presented');
    if(!readTarget.presented){assert(readTarget.coverage.every(Boolean),'Adaptive tiles left gaps');readTarget.presented=true;presented++;frames.push({phi:readTarget.phi,preview:readTarget.preview,edges:readTarget.edges,surfaceTransparency:readTarget.surfaceTransparency,viewStamp:readTarget.viewStamp,time:performance.now(),tiles:readTarget.tiles,width:readTarget.width,height:readTarget.height});}
  },
  clearColor:()=>{},clear:()=>{},getError:()=>0,
  fenceSync:()=>{inFlight++;peak=Math.max(peak,inFlight);return {polls:0,readyAt:performance.now()+gpuDelay};},flush:()=>{},
  clientWaitSync:s=>{if(s.polls++===0||performance.now()<s.readyAt)return 2;inFlight--;return 3;},deleteSync:()=>{},
  deleteProgram:()=>{},deleteVertexArray:()=>{}
};
let rect={width:240,height:160};const listeners={},captures=new Set();
const canvas={width:1,height:1,getBoundingClientRect:()=>rect,addEventListener:(name,handler)=>{listeners[name]=handler;},focus:()=>{},setPointerCapture:id=>captures.add(id),hasPointerCapture:id=>captures.has(id),releasePointerCapture:id=>captures.delete(id)};
const volume={kind:'explicit',dims:[400,250,100],bounds:{min:[-3.5,-2,-1.5],max:[3.5,2,1.5]},stats:{cells:10000000,activeCells:3},sortedPhi:new Float32Array([.18,.2,.24])};
const renderer=new ExplicitVolumeRenderer(canvas,volume,e=>errors.push(e));renderer.gl=gl;renderer.blockCount=8;renderer.textures=Array.from({length:9},(_,i)=>({index:i}));
const renderFrame=renderer.renderFrame.bind(renderer);renderer.renderFrame=(job,cancelled)=>{started.push({...job,time:performance.now()});return renderFrame(job,cancelled);};
renderer.uniforms=Object.fromEntries(['uResolution','uPixelRatio','uEye','uRight','uUp','uForward','uTanFov','uDensity','uEdgeWidth','uProperty','uEdges','uInterior','uPorosityFilter','uPhi','uClipAxis','uClipPosition','uNoMatches','uSurfacePreview','uBlockCount','uBlockTraversal','uFastConnections'].map(n=>[n,n]));
renderer.onMetrics=m=>events.push({...m,time:performance.now()});renderer.bindInput(new AbortController().signal);renderer.setSettings({property:0,density:60,edges:true,lineWidth:1.2,interior:true,clipAxis:0,clip:0,porosityFilter:true,porosityMin:8,porosityMax:32});
await pause(2);
const beforeSliderDraws=draws;
for(let i=0;i<100;i++)renderer.setSettings({...renderer.settings,porosityMin:18+i*.001},true);
assert.equal(draws,beforeSliderDraws,'Synchronous slider burst submitted work');renderer.setSettings({...renderer.settings,porosityMin:20},false);
await pause(450);assert(frames.some(f=>f.preview===1),'No rapid filter preview');
assert.deepEqual(frames.at(-1).phi,[Math.fround(.2),Math.fround(.32)]);
const before=presented;
for(let i=0;i<50;i++){renderer.rotate(2,1);await pause(5);}
assert(presented>before+2,'Continuous rotation starved all preview presentation');
await until(()=>events.at(-1)?.phase==='ready');
assert.equal(events.at(-1)?.phase,'ready','Full volume did not return after interaction');

// Pointer release supersedes the queued low-res frame immediately. Releasing
// just one finger must not end an ongoing two-finger gesture.
const pointer=(pointerId,x=0,y=0)=>({pointerId,clientX:x,clientY:y,buttons:1});
listeners.pointerdown(pointer(1));listeners.pointerdown(pointer(2,20));listeners.pointermove(pointer(2,25,5));
const heldVersion=renderer.requestVersion;listeners.pointerup(pointer(1));assert.equal(renderer.requestVersion,heldVersion);
const releaseIndex=started.length,releasedAt=performance.now();listeners.pointerup(pointer(2));
assert.equal(renderer.interacting,false);await until(()=>events.at(-1)?.phase==='ready'&&started.length>releaseIndex);
assert.deepEqual(started.slice(releaseIndex).map(f=>f.preview),[false],'Release generated an unnecessary preview');
const releaseStartMs=started[releaseIndex].time-releasedAt;assert(releaseStartMs<50,'Release retained an idle timeout');

// A preview slower than the quiet period must not incur a second timeout.
renderer.previewPixels=256;gpuDelay=120;const quietIndex=started.length,quietAt=performance.now();renderer.rotate(1,1);
await until(()=>started.length>quietIndex);await pause(90);
assert.equal(renderer.queue.pending?.payload.preview,false,'Quiet timer waited for preview completion');
gpuDelay=0;await until(()=>events.at(-1)?.phase==='ready'&&started.length>quietIndex+1);
const quietStartMs=started[quietIndex+1].time-quietAt;
assert.equal(started[quietIndex+1].preview,false);assert(quietStartMs<220,'Slow preview added an extra idle delay');

// The very first full frame learns a useful batch size; verify every pixel
// exactly once on non-square, non-multiple-of-tile dimensions.
rect={width:641,height:397};renderer.quality='fast';renderer.tilePixels=1024;
await renderer.draw();const sharp=frames.at(-1),fixedTiles=Math.ceil(sharp.width/32)*Math.ceil(sharp.height/32);
assert(sharp.tiles<fixedTiles/2,'First refinement retained tiny batches for the whole frame');
assert.equal(frames.at(-1).preview,0);assert.equal(peak,1);assert.deepEqual(errors,[]);
// The ray fallback must also discard old styles, including changes while its
// GPU batches are in flight.
for(const edges of [false,true]){
 renderer.previewPixels=12000;renderer.previewTilePixels=1024;gpuDelay=25;renderer.rotate(1,0);
 await until(()=>inFlight===1&&lastSubmittedFrame?.preview===1);
 const begin=frames.length;renderer.setSettings({...renderer.settings,edges});gpuDelay=0;
 await until(()=>events.at(-1)?.phase==='ready');
 assert(frames.length>begin);assert(frames.slice(begin).every(f=>f.edges===edges),'A stale ray edge-toggle frame was presented');
}
// Exercise the production cached raster path under the same delayed-fence
// producer. Only GPU calls are faked; renderer scheduling/presentation is real.
let rasterMode=false,meshSnapshot=null,meshIndex=0,transparencyFrame=null;const cacheRequests=[];
const prepare=renderer.prepareFrame.bind(renderer);renderer.prepareFrame=cap=>{rasterMode=false;return prepare(cap);};
const rayDraw=gl.drawArrays,blit=gl.blitFramebuffer;
Object.assign(gl,{createRenderbuffer:()=>({}),bindRenderbuffer:()=>{},renderbufferStorage:()=>{},framebufferRenderbuffer:()=>{},deleteRenderbuffer:()=>{},depthMask:()=>{},clearDepth:()=>{},depthFunc:()=>{},bindBuffer:()=>{},vertexAttribIPointer:()=>{},bufferData:()=>assert.equal(inFlight,0),bufferSubData:()=>assert.equal(inFlight,0)});
renderer.surface={key:surfaceKey(renderer.settings,volume),bytes:720000,batchFaces:32768,
 gl,uniforms:[{uPacked:'uPacked'}],batches:[{offset:0,count:180000,vertices:6,packed:0}],
 bind:(index,snapshot)=>{rasterMode=true;meshIndex=index;meshSnapshot=snapshot;},
 upload:SurfaceRaster.prototype.upload,dispose:()=>{}};
globalThis.Worker=class{postMessage(d){if(d.type==='build')cacheRequests.push(d);}terminate(){}};
renderer.afterTextureUpload();renderer.surfaceRequestedKey=renderer.surface.key;
const beginRaster=()=>{
 drawTarget.raster=true;drawTarget.meshFaces=0;drawTarget.expectedFaces=meshSnapshot.settings.surfaceTransparency===100&&!meshSnapshot.settings.edges?0:renderer.surface.batches.reduce((a,b)=>a+b.count*b.vertices/6,0);
 drawTarget.pixels=drawTarget.width*drawTarget.height;drawTarget.coverage.fill(1);drawTarget.preview=2;drawTarget.phi=[Math.fround(meshSnapshot.settings.porosityMin/100),Math.fround(meshSnapshot.settings.porosityMax/100)];
 drawTarget.edges=meshSnapshot.settings.edges;
 drawTarget.surfaceTransparency=meshSnapshot.settings.surfaceTransparency;
 drawTarget.viewStamp=renderer.surfaceViewStamp();
};
gl.drawArrays=()=>{
 if(!rasterMode)return rayDraw();assert.equal(inFlight,0);beginRaster();
 if(meshIndex===3){assert(transparencyFrame&&!transparencyFrame.deleted);drawTarget.meshFaces=transparencyFrame.meshFaces;}
};
gl.drawArraysInstanced=(_mode,_first,vertices,count)=>{assert.equal(inFlight,0);if(!drawTarget.raster)beginRaster();assert(vertices>=6&&vertices<=36&&vertices%6===0);assert(count*vertices/6<=131072);drawTarget.meshFaces+=count*vertices/6;draws++;};
gl.blitFramebuffer=()=>{if(readTarget?.raster)assert.equal(readTarget.meshFaces,readTarget.expectedFaces,'Partially drawn surface was presented');blit();};
const rasterStart=presented;
for(let i=0;i<25;i++){renderer.rotate(2,1);await pause(5);}
await until(()=>events.at(-1)?.phase==='ready');
const rasterFrames=frames.slice(rasterStart).filter(f=>f.preview===2);
assert(rasterFrames.length>=2,'Cached surfaces starved during rotation');
assert(rasterFrames.every(f=>f.width===641&&f.height===397),'Surface resolution dropped to the ray-preview size');
assert.equal(rasterFrames.at(-1).viewStamp,renderer.surfaceViewStamp(),'Refinement kept the pre-release camera surface');
assert.equal(canvas.width,641,'Full refinement shrank the displayed sharp surface');
assert.equal(canvas.height,397);assert.equal(cacheRequests.length,0,'Camera changes rebuilt the surface cache');
// A cache for a previous filter must not be used while its replacement builds.
const staleStart=frames.length;renderer.setSettings({...renderer.settings,porosityMin:23},true);
await until(()=>cacheRequests.length>0);renderer.endInteraction();await until(()=>events.at(-1)?.phase==='surface-pending');
assert(!frames.slice(staleStart).some(f=>f.preview===2),'Stale filter surface presented');
const key=surfaceKey(renderer.settings,volume);renderer.surfaceWorker.onmessage({data:{type:'surface',key,faces:new Uint32Array(180000),caps:new Uint32Array(0),groups:[60000,60000,60000,0,0,0]}});
await until(()=>frames.slice(staleStart).some(f=>f.preview===2));
await until(()=>events.at(-1)?.phase==='ready');assert.equal(peak,1);assert.deepEqual(errors,[]);
// Every subsequent interaction after a completed filter/section must use the
// reusable shell. Test all axes together with filtering and packed face batches.
for(const axis of [0,1,2,3]){
 renderer.setSettings({...renderer.settings,clipAxis:axis,clip:38});
 if(axis){
  await until(()=>events.at(-1)?.phase==='surface-pending');
  const key=surfaceKey(renderer.settings,volume);
  renderer.surfaceWorker.onmessage({data:{type:'surface',key,faces:new Uint32Array(180000),caps:new Uint32Array(2500),groups:[60000,60000,60000,0,0,0]}});
 }
 await until(()=>events.at(-1)?.phase==='ready');
 const begin=frames.length,requests=cacheRequests.length;
 for(let n=0;n<15;n++){renderer.rotate(2,1);await pause(5);}
 renderer.endInteraction();await until(()=>events.at(-1)?.phase==='ready');
 const rotated=frames.slice(begin);assert(rotated.some(f=>f.preview===2),'Processed surface was not reused');
 assert(!rotated.some(f=>f.preview===1),'Completed filter/section fell back to blurry ray preview');
 assert(rotated.filter(f=>f.preview===2).every(f=>f.width===641&&f.height===397));
 assert.equal(cacheRequests.length,requests,'Rotation rebuilt a processed filter/section');
}
// Toggle while a previous shell is waiting on the GPU: only frames matching
// the new edge setting may be committed, even though geometry is unchanged.
const requestsBeforeToggles=cacheRequests.length;
for(const edges of [false,true,false,true]){
 gpuDelay=25;renderer.rotate(1,0);await until(()=>inFlight===1&&drawTarget?.raster);
 const begin=frames.length;renderer.setSettings({...renderer.settings,edges});gpuDelay=0;
 await until(()=>events.at(-1)?.phase==='ready');
 assert(frames.length>begin);assert(frames.slice(begin).every(f=>f.edges===edges),'A stale edge-toggle frame was presented');
}
assert.equal(cacheRequests.length,requestsBeforeToggles,'Edge toggles rebuilt geometry');
// Partial volume appears before completion, without shrinking or recopying the
// sharp base on every tile. Rotations and style changes cancel partial output.
const progressiveStart=patches.length,copyStart=fullCopies,seedStart=seedCopies,cacheStart=cacheRequests.length;
gpuDelay=8;renderer.setSettings({...renderer.settings,progressive:true,density:15});
await until(()=>patches.length>progressiveStart);
const firstPatch=patches[progressiveStart],cancelledBack=firstPatch.target;
assert(firstPatch.pixels<firstPatch.total,'Progressive display waited for the whole volume');
assert.notEqual(renderer.front,renderer.back,'Partial work replaced the committed shell');
renderer.rotate(2,1);gpuDelay=0;
await until(()=>events.at(-1)?.phase==='ready');assert(cancelledBack.deleted,'Cancelled partial image was retained');
assert(patches.length>progressiveStart+1);assert.equal(seedCopies-seedStart,2);
assert(fullCopies-copyStart<10,'Refinement still copies a full base on every tile');
for(const patch of [{edges:false},{lightMode:true},{property:1}]){
 gpuDelay=8;renderer.setSettings({...renderer.settings,density:renderer.settings.density===15?30:15});
 const before=patches.length;await until(()=>patches.length>before);const abandoned=renderer.back;
 renderer.setSettings({...renderer.settings,...patch});gpuDelay=0;
 await until(()=>events.at(-1)?.phase==='ready');assert(abandoned.fbo.deleted,'Style change retained partial volume');
}
assert.equal(cacheRequests.length,cacheStart,'Progressive display rebuilt geometry');
gpuDelay=8;renderer.setSettings({...renderer.settings,density:renderer.settings.density===15?30:15});
const beforeFilter=patches.length;await until(()=>patches.length>beforeFilter);
const filteredBack=renderer.back,patchesBeforeNewFilter=patches.length;
renderer.setSettings({...renderer.settings,porosityMin:21});gpuDelay=0;
await until(()=>events.at(-1)?.phase==='surface-pending');
assert(filteredBack.fbo.deleted);assert.equal(patches.length,patchesBeforeNewFilter,'Old filter kept presenting partial volume');
renderer.surfaceWorker.onmessage({data:{type:'surface',key:surfaceKey(renderer.settings,volume),faces:new Uint32Array(180000),caps:new Uint32Array(2500),groups:[60000,60000,60000,0,0,0]}});
await until(()=>events.at(-1)?.phase==='ready');assert(patches.length>patchesBeforeNewFilter);
const beforeDisabled=patches.length;
renderer.setSettings({...renderer.settings,progressive:false});await until(()=>events.at(-1)?.phase==='ready');
assert.equal(patches.length,beforeDisabled,'Disabled progression still presented partial results');
renderer.settings={...renderer.settings,progressive:true};renderer.benchmarking=true;
await renderer.draw();renderer.benchmarking=false;
assert.equal(patches.length,beforeDisabled,'Benchmark used partial presentation');
// Exercise real MRT allocation/resolve orchestration; numerical blending is
// checked separately against GLES. Keeping the shell must not start ray work.
Object.assign(gl,{TEXTURE6:6,COLOR_ATTACHMENT0:0,COLOR_ATTACHMENT1:1,drawBuffers:()=>{},clearBufferfv:()=>{},blendEquation:()=>{},blendFunc:()=>{}});
Object.assign(renderer.surface,{transparencySupported:true,
 createTransparencyTarget(w,h){const target=SurfaceRaster.prototype.createTransparencyTarget.call(this,w,h);transparencyFrame=target.fbo;return target;},
 resolveTransparency:SurfaceRaster.prototype.resolveTransparency,deleteTransparencyTarget:SurfaceRaster.prototype.deleteTransparencyTarget});
renderer.surface.uniforms[2]={uPacked:'uPacked'};renderer.surface.uniforms[3]={uSurfaceAccum:'uSurfaceAccum',uSurfaceDepth:'uSurfaceDepth'};
const beforeOpacity=frames.length,geometryRequests=cacheRequests.length;
for(const surfaceTransparency of [0,25,70,100]){
 renderer.setSettings({...renderer.settings,surfaceOnly:true,surfaceTransparency});await until(()=>events.at(-1)?.phase==='surface-only');
 renderer.rotate(1,0);renderer.endInteraction();await until(()=>events.at(-1)?.phase==='surface-only');
 if(surfaceTransparency>0)assert(transparencyFrame.deleted,'Transparency buffers leaked after presentation');
}
renderer.setSettings({...renderer.settings,edges:false});await until(()=>events.at(-1)?.phase==='surface-only');
assert(frames.slice(beforeOpacity).every(f=>f.preview===2),'Surface mode unexpectedly started volume refinement');
assert.equal(cacheRequests.length,geometryRequests,'Opacity rebuilt the geometry');assert.equal(peak,1);assert.deepEqual(errors,[]);
gpuDelay=25;renderer.setSettings({...renderer.settings,surfaceTransparency:35});
await until(()=>inFlight===1&&transparencyFrame&&!transparencyFrame.deleted);
const abandonedTarget=transparencyFrame,afterChange=frames.length;renderer.setSettings({...renderer.settings,surfaceTransparency:80});gpuDelay=0;
await until(()=>events.at(-1)?.phase==='surface-only');
assert(frames.slice(afterChange).every(f=>f.surfaceTransparency===80),'Old translucent frame committed after slider change');
assert(abandonedTarget.deleted&&transparencyFrame.deleted,'Cancelled transparency buffers leaked');
renderer.setSettings({...renderer.settings,surfaceOnly:false});await until(()=>events.at(-1)?.phase==='ready');
// The opaque endpoint must override a retained surface transparency value,
// reuse full-resolution filtered/capped geometry, and never refine behind it.
const opaqueStart=frames.length,opaqueRequests=cacheRequests.length;
renderer.setSettings({...renderer.settings,density:100,edges:true});
await until(()=>events.at(-1)?.phase==='opaque-ready');
renderer.rotate(2,1);renderer.endInteraction();
await until(()=>events.at(-1)?.phase==='opaque-ready');
renderer.benchmarking=true;await renderer.draw();renderer.benchmarking=false;
const opaqueFrames=frames.slice(opaqueStart);assert(opaqueFrames.length>=2);
assert(opaqueFrames.every(f=>f.preview===2&&f.surfaceTransparency===0&&f.width===641&&f.height===397),'Opaque endpoint traced volume, leaked transparency or reduced resolution');
assert.equal(cacheRequests.length,opaqueRequests,'Density rebuilt filtered/capped geometry');
assert.equal(renderer.settings.surfaceTransparency,80,'Opaque endpoint mutated independent surface settings');
renderer.setSettings({...renderer.settings,surfaceOnly:true});await until(()=>events.at(-1)?.phase==='surface-only');
assert.equal(frames.at(-1).surfaceTransparency,80,'Surface-only transparency was overridden');
renderer.setSettings({...renderer.settings,surfaceOnly:false,density:99});await until(()=>events.at(-1)?.phase==='ready');
assert.equal(frames.at(-1).preview,0,'Leaving opaque endpoint did not restore volume');
renderer.setSettings({...renderer.settings,blockTraversal:false});await until(()=>events.at(-1)?.phase==='ready');
assert.equal(uniforms.uFastConnections,0);assert.equal(uniforms.uBlockTraversal,0);
renderer.dispose();await pause(5);assert.equal(inFlight,0);
const stopped=draws;await pause(220);assert.equal(draws,stopped,'Work continued after disposal');
console.log('PASS production renderer: one GPU batch, complete coverage, progressive presentation, cancellation, rotation, adaptive tiles and disposal',{frames:presented,patches:patches.length,seedCopies,peakInFlight:peak,releaseStartMs,slowPreviewRefineStartMs:quietStartMs,firstRefinementTiles:sharp.tiles,fixedTiles});
