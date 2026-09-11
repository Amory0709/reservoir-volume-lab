// Production renderer with a deliberately delayed GPU fence; no browser/DOM.
import assert from 'node:assert/strict';
import {ExplicitVolumeRenderer} from './dist/explicit-renderer.js';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
globalThis.window={devicePixelRatio:1};globalThis.requestAnimationFrame=f=>setTimeout(()=>f(performance.now()),0);globalThis.cancelAnimationFrame=clearTimeout;
let inFlight=0,peak=0,draws=0,presented=0,drawTarget=null,readTarget=null,texture=null,scissor=null,gpuDelay=0;
const uniforms={},frames=[],events=[],errors=[],started=[];
const until=async predicate=>{const deadline=performance.now()+5000;while(!predicate()&&performance.now()<deadline)await pause(2);assert(predicate(),'Renderer did not complete');};
const gl={NO_ERROR:0,FRAMEBUFFER_COMPLETE:1,TIMEOUT_EXPIRED:2,CONDITION_SATISFIED:3,ALREADY_SIGNALED:4,WAIT_FAILED:5,
  FRAMEBUFFER:10,DRAW_FRAMEBUFFER:11,READ_FRAMEBUFFER:12,SCISSOR_TEST:13,
  createTexture:()=>({}),createFramebuffer:()=>({pixels:0}),deleteTexture:()=>{},deleteFramebuffer:f=>{f.deleted=true;},
  activeTexture:()=>{},bindTexture:(_,t)=>{texture=t;},texParameteri:()=>{},texImage2D:(_a,_b,_c,w,h)=>{texture.width=w;texture.height=h;},
  bindFramebuffer:(target,f)=>{if(target===10||target===11)drawTarget=f;if(target===10||target===12)readTarget=f;},
  framebufferTexture2D:()=>{Object.assign(drawTarget,{width:texture.width,height:texture.height,coverage:new Uint8Array(texture.width*texture.height),tiles:0});},checkFramebufferStatus:()=>1,
  uniform3fv:(k,v)=>{uniforms[k]=[...v];},uniform3iv:()=>{},uniform1i:(k,v)=>{uniforms[k]=v;},uniform1f:()=>{},uniform2f:(k,a,b)=>{uniforms[k]=[a,b];},
  viewport:()=>{},useProgram:()=>{},bindVertexArray:()=>{},enable:()=>{},disable:()=>{},scissor:(x,y,w,h)=>{scissor=[x,y,w,h];},
  drawArrays:()=>{
    assert.equal(inFlight,0,'Renderer submitted work before previous fence');assert(drawTarget&&!drawTarget.deleted);
    const [x,y,w,h]=scissor;assert(x>=0&&y>=0&&x+w<=drawTarget.width&&y+h<=drawTarget.height);assert(w*h<=16384,'GPU batch exceeded its cap');
    for(let row=y;row<y+h;row++){
      const offset=row*drawTarget.width+x;assert(!drawTarget.coverage.subarray(offset,offset+w).some(Boolean),'Adaptive tiles overlap');drawTarget.coverage.fill(1,offset,offset+w);
    }
    drawTarget.tiles++;
    draws++;drawTarget.pixels+=scissor[2]*scissor[3];drawTarget.phi=[...uniforms.uPhi];drawTarget.preview=uniforms.uSurfacePreview;
  },
  blitFramebuffer:()=>{
    assert(readTarget&&!readTarget.deleted);assert.equal(readTarget.pixels,readTarget.width*readTarget.height,'Incomplete frame presented');
    if(!readTarget.presented){assert(readTarget.coverage.every(Boolean),'Adaptive tiles left gaps');readTarget.presented=true;presented++;frames.push({phi:readTarget.phi,preview:readTarget.preview,time:performance.now(),tiles:readTarget.tiles,width:readTarget.width,height:readTarget.height});}
  },
  clearColor:()=>{},clear:()=>{},getError:()=>0,
  fenceSync:()=>{inFlight++;peak=Math.max(peak,inFlight);return {polls:0,readyAt:performance.now()+gpuDelay};},flush:()=>{},
  clientWaitSync:s=>{if(s.polls++===0||performance.now()<s.readyAt)return 2;inFlight--;return 3;},deleteSync:()=>{},
  deleteProgram:()=>{},deleteVertexArray:()=>{}
};
let rect={width:240,height:160};const listeners={},captures=new Set();
const canvas={width:1,height:1,getBoundingClientRect:()=>rect,addEventListener:(name,handler)=>{listeners[name]=handler;},focus:()=>{},setPointerCapture:id=>captures.add(id),hasPointerCapture:id=>captures.has(id),releasePointerCapture:id=>captures.delete(id)};
const volume={kind:'explicit',dims:[400,250,100],bounds:{min:[-3.5,-2,-1.5],max:[3.5,2,1.5]},stats:{cells:10000000,activeCells:3},sortedPhi:new Float32Array([.18,.2,.24])};
const renderer=new ExplicitVolumeRenderer(canvas,volume,e=>errors.push(e));renderer.gl=gl;
const renderFrame=renderer.renderFrame.bind(renderer);renderer.renderFrame=(job,cancelled)=>{started.push({...job,time:performance.now()});return renderFrame(job,cancelled);};
renderer.uniforms=Object.fromEntries(['uResolution','uPixelRatio','uEye','uRight','uUp','uForward','uTanFov','uDensity','uEdgeWidth','uProperty','uEdges','uInterior','uPorosityFilter','uPhi','uClipAxis','uClipPosition','uNoMatches','uSurfacePreview'].map(n=>[n,n]));
renderer.onMetrics=m=>events.push({...m,time:performance.now()});renderer.bindInput(new AbortController().signal);renderer.setSettings({property:0,density:60,edges:true,lineWidth:1.2,interior:true,clipAxis:0,clip:0,porosityFilter:true,porosityMin:8,porosityMax:32});
await pause(2);
for(let i=0;i<100;i++)renderer.setSettings({...renderer.settings,porosityMin:18+i*.001},true);
assert(draws<5,'Slider burst submitted full frames');renderer.setSettings({...renderer.settings,porosityMin:20},false);
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
renderer.dispose();await pause(5);assert.equal(inFlight,0);
const stopped=draws;await pause(220);assert.equal(draws,stopped,'Work continued after disposal');
console.log('PASS production renderer: coalescing, single GPU batch, complete-frame presentation, rotation, immediate release, input-based quiet time, adaptive pixel coverage and disposal',{frames:presented,peakInFlight:peak,releaseStartMs,slowPreviewRefineStartMs:quietStartMs,firstRefinementTiles:sharp.tiles,fixedTiles});
