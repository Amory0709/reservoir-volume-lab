// Exercise production JS and the real TypeGPU packer with a delayed WebGPU queue.
// Native tests separately execute the shaders; this checks lifecycle/cancellation.
import assert from 'node:assert/strict';
import {WebGPUVolumeRenderer} from './dist/webgpu-renderer.js';
import {makeExplicitGrid} from './dist/explicit-grid.js';
import {surfaceKey} from './dist/surface-cache.js';
import {ComparisonRenderer,comparisonRect} from './dist/comparison-renderer.js';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
globalThis.window={devicePixelRatio:1};globalThis.requestAnimationFrame=f=>setTimeout(()=>f(performance.now()),0);globalThis.cancelAnimationFrame=clearTimeout;
globalThis.GPUBufferUsage={MAP_READ:1,MAP_WRITE:2,COPY_SRC:4,COPY_DST:8,INDEX:16,VERTEX:32,UNIFORM:64,STORAGE:128,INDIRECT:256,QUERY_RESOLVE:512};
globalThis.GPUTextureUsage={COPY_SRC:1,COPY_DST:2,TEXTURE_BINDING:4,STORAGE_BINDING:8,RENDER_ATTACHMENT:16};globalThis.GPUShaderStage={VERTEX:1,FRAGMENT:2,COMPUTE:4};globalThis.GPUMapMode={READ:1};
globalThis.ResizeObserver=class{observe(){}disconnect(){}};
globalThis.Worker=class{postMessage(data){queueMicrotask(()=>this.onmessage?.({data:data.type==='init'?{type:'initialized'}:{type:'surface',lane:data.lane??'default',key:data.key,faces:new Uint32Array([63]),groups:[0,0,0,0,0,1],caps:new Uint32Array(0)}}));}terminate(){this.onmessage=null;}};
const errors=[],events=[],presentations=[],computes=[];let heavyPending=0,peak=0,delay=0,deviceDestroyed=false;
const texture=desc=>({...desc,dead:false,createView(){assert(!this.dead);return {texture:this};},destroy(){this.dead=true;}});
const queue={
 writeBuffer(buffer,offset,data,start=0,length){assert(!buffer.dead);const bytes=ArrayBuffer.isView(data)?new Uint8Array(data.buffer,data.byteOffset,data.byteLength):new Uint8Array(data);new Uint8Array(buffer.data).set(bytes.subarray(start,length===undefined?undefined:start+length),offset);},
 writeTexture:()=>{},
 submit(commands){
  for(const command of commands)for(const pass of command.passes){
   const pipeline=pass.pipeline,name=pipeline?.compute?.entryPoint??pipeline?.fragment?.entryPoint;
   if(!name)continue;
   if(name==='presentFragment'){
    for(const snapshot of pass.draws){const image=snapshot.groups[0].entries[0].resource.texture;
    assert(!image.dead);if(image.coverage)assert(image.coverage.every(Boolean),'Incomplete volume presented');
    presentations.push({image,flags:image.flags,counts:image.counts,viewport:snapshot.viewport});}continue;
   }
   const data=pass.groups[0].entries[0].resource.buffer.data,u=new Uint32Array(data),f=new Float32Array(data);
   assert.equal(data.byteLength,224,'TypeGPU uniform layout differs from WGSL');assert(Math.abs(f[3]-Math.tan(21*Math.PI/180))<1e-6);
   if(name==='computeMain'){
    assert.equal(heavyPending,0,'Compute queued before previous batch completed');heavyPending++;peak=Math.max(peak,heavyPending);
    const target=pass.groups[1].entries[0].resource.texture,[x,y,w,h]=u.slice(52,56),[width,height]=f.slice(40,42);
    assert.equal(target.size[0],width);assert.equal(target.size[1],height);assert(w*h<=65536);
    assert.deepEqual(pass.dispatch,[Math.ceil(w/8),Math.ceil(h/8)]);
    target.coverage??=new Uint8Array(width*height);
    for(let row=y;row<y+h;row++)for(let col=x;col<x+w;col++){const i=row*width+col;assert.equal(target.coverage[i],0,'Overlapping compute tiles');target.coverage[i]=1;}
    target.flags=[...u.slice(36,40)];target.counts=[...u.slice(32,36)];computes.push({target,tile:[x,y,w,h],flags:target.flags});
   }
  }
 },
 async onSubmittedWorkDone(){await pause(delay);heavyPending=0;}
};
const device={queue,limits:{maxTextureDimension3D:2048,maxTextureDimension2D:8192,maxBufferSize:268435456},lost:new Promise(()=>{}),addEventListener:()=>{},pushErrorScope:()=>{},popErrorScope:async()=>null,
 createBuffer(desc){return {...desc,data:new ArrayBuffer(desc.size),mapState:'unmapped',dead:false,destroy(){this.dead=true;},async mapAsync(){assert(!this.dead);this.mapState='mapped';},getMappedRange(){return this.data;},unmap(){this.mapState='unmapped';}};},
 createTexture:texture,createBindGroupLayout:d=>d,createBindGroup:d=>d,createPipelineLayout:d=>d,createSampler:d=>d,
 createShaderModule:()=>({getCompilationInfo:async()=>({messages:[]})}),createComputePipelineAsync:async d=>d,createRenderPipelineAsync:async d=>d,
 createCommandEncoder(){const passes=[];const pass=descriptor=>{const result={descriptor,groups:[],draws:[],setViewport(...v){this.viewport=v;},setScissorRect(){},setPipeline(p){this.pipeline=p;},setBindGroup(i,g){this.groups[i]=g;},setVertexBuffer:()=>{},draw(){this.draws.push({groups:[...this.groups],viewport:this.viewport});},dispatchWorkgroups(...v){this.dispatch=v;},end(){passes.push(this);}};return result;};return {beginComputePass:pass,beginRenderPass:pass,finish:()=>({passes})};},destroy(){deviceDestroyed=true;}
};
Object.defineProperty(globalThis,'navigator',{value:{gpu:{requestAdapter:async()=>({limits:device.limits,features:new Set(),requestDevice:async()=>device}),getPreferredCanvasFormat:()=> 'bgra8unorm'}},configurable:true});
const context={configure:()=>{},unconfigure:()=>{},getCurrentTexture:()=>texture({size:[240,160]})};
let rect={width:241,height:163};const canvas={width:1,height:1,ownerDocument:{documentElement:{dataset:{theme:'light'}}},getContext:type=>{assert.equal(type,'webgpu');return context;},getBoundingClientRect:()=>rect,addEventListener:()=>{}};
const volume=makeExplicitGrid('test',()=>{},[20,12,10]);const renderer=new WebGPUVolumeRenderer(canvas,volume,error=>errors.push(error));renderer.onMetrics=m=>events.push(m);
await renderer.initialize();assert.equal(volume.vertices,null);assert(renderer.surfacePending);
const settings={lightMode:true,progressive:false,property:0,density:60,edges:true,lineWidth:1.2,interior:true,surfaceTransparency:0,surfaceOnly:false,clipAxis:0,clip:0,porosityFilter:false,porosityMin:8,porosityMax:32};
const until=async predicate=>{const end=performance.now()+5000;while(!predicate()&&performance.now()<end)await pause(2);assert(predicate(),'Render queue did not settle');};
renderer.settings={...settings};await renderer.drawInitial();await until(()=>events.at(-1)?.phase==='ready');
assert(presentations.some(p=>p.image.coverage),'No completed volume');assert(computes.length>1);
// Replace a filter and line setting during an expensive volume tile. Only the
// latest full result may reach presentation; the retained shell stays complete.
renderer.surfaceDisabled=true;renderer.surfaceWorker?.terminate();renderer.surfaceWorker=null;
delay=20;renderer.requestRefinement(renderer.requestVersion);await until(()=>heavyPending===1);
const before=presentations.length;renderer.setSettings({...settings,edges:false,porosityFilter:true,porosityMin:18,porosityMax:25});delay=0;
await until(()=>events.at(-1)?.phase==='ready'&&presentations.length>before);
assert(presentations.slice(before).filter(p=>p.image.coverage).every(p=>p.flags[2]===0),'Stale edge toggle reached the screen');
assert.equal(peak,1);assert.deepEqual(errors,[]);
// Re-enable the production raster path and exercise both OIT and transparent wireframe.
renderer.surfaceDisabled=false;renderer.settings={...settings,surfaceTransparency:100,surfaceOnly:true};renderer.surface.key=surfaceKey(renderer.settings,volume);
assert(await renderer.queue.request({preview:true}));assert.equal(events.at(-1).phase,'surface-only');
renderer.settings={...renderer.settings,edges:false};assert(await renderer.queue.request({preview:true}));
const opaqueComputes=computes.length;
renderer.settings={...settings,density:100,surfaceTransparency:80};
assert(await renderer.draw());assert.equal(events.at(-1).phase,'opaque-ready');
assert.equal(renderer.frameValues.boundsMax[3],1,'Opaque volume retained surface transparency');
renderer.camera.azimuth+=.1;assert(await renderer.queue.request({preview:true}));assert(await renderer.draw());
assert.equal(computes.length,opaqueComputes,'Opaque endpoint invoked volume compute');
renderer.settings={...renderer.settings,surfaceOnly:true};assert(await renderer.draw());
assert.equal(events.at(-1).phase,'surface-only');assert(Math.abs(renderer.frameValues.boundsMax[3]-.2)<1e-6);
renderer.settings={...renderer.settings,surfaceOnly:false,density:99};assert(await renderer.draw());
assert.equal(events.at(-1).phase,'ready');assert(computes.length>opaqueComputes,'Translucent volume was not restored');
// Resizing restores an existing full image before the next asynchronous batch.
rect={width:417,height:251};renderer.settings={...settings};renderer.surfaceDisabled=true;await renderer.draw();
assert.equal(canvas.width,417);assert.equal(canvas.height,251);
// Device destruction while a queue batch is pending must cancel cleanly.
delay=30;const outstanding=renderer.draw();await until(()=>heavyPending===1);renderer.dispose();assert.equal(await outstanding,false);assert(deviceDestroyed);assert.deepEqual(errors,[]);
console.log('PASS WebGPU TypeGPU packing, initialization, complete-frame presentation, settings cancellation, OIT path, resize and disposal', {computeBatches:computes.length,presentations:presentations.length,peak});

// Two production panes reuse one device, grid and GPU queue. Exercise the new
// compositor, independent settings, camera link, right-side preemption and teardown.
delay=0;deviceDestroyed=false;let uploads=0;queue.writeTexture=()=>uploads++;
const geometry=makeExplicitGrid('compare',()=>{},[20,12,10]);
const fullRect={left:0,top:0,right:500,bottom:300,width:500,height:300};
const compareCanvas={...canvas,width:1,height:1,getBoundingClientRect:()=>fullRect};
const panes=['volume','surface'].map((id,i)=>({id,settings:{...settings,surfaceOnly:id==='surface'},quality:'fast',element:{...canvas,getBoundingClientRect:()=>({left:i*250,top:50,right:(i+1)*250,bottom:220,width:250,height:170})}}));
const comparisonErrors=[],comparisonEvents=[];
const comparison=new ComparisonRenderer(compareCanvas,geometry,panes,{backend:'webgpu',onError:e=>comparisonErrors.push(e),onMetrics:(view,metrics)=>comparisonEvents.push({id:view.id,...metrics})});
await comparison.initialize();await until(()=>!panes[0].needVolume&&!panes[1].needSurface);
const settledEpoch=comparison.epoch,settledComputes=computes.length;
comparison.resize();comparison.resize();comparison.setQuality(panes[0],panes[0].quality);comparison.setSettings(panes[0],{density:panes[0].settings.density});
await pause(5);assert.equal(comparison.epoch,settledEpoch,'Unchanged layout/settings restarted the volume');assert.equal(computes.length,settledComputes);
assert.equal(uploads,6,'Dual panes uploaded geometry twice');assert.equal(comparison.renderer.volume,geometry);assert.notEqual(panes[0].front,panes[1].front);assert.notEqual(panes[0].surface,panes[1].surface);
assert(panes[0].front.texture.coverage.every(Boolean));assert(!panes[1].front.texture.coverage,'Surface pane invoked the volume compute pipeline');
assert(presentations.some(p=>p.viewport?.[0]===0));assert(presentations.some(p=>p.viewport?.[0]===250));
assert.deepEqual(comparisonRect({left:100,top:50,right:300,bottom:250},{left:0,top:0,width:500,height:300},1000,600),{x:200,y:100,width:400,height:400});
// Linked movement is copied, not aliased; disabling link makes the other camera stable.
panes[0].controller.rotate(3,2);assert.deepEqual(panes[0].controller.camera,panes[1].controller.camera);assert.notEqual(panes[0].controller.camera,panes[1].controller.camera);
comparison.endInteraction(panes[0]);await until(()=>!panes[0].needVolume&&!panes[1].needSurface);
comparison.setLinked(false);const leftCamera=structuredClone(panes[0].controller.camera);panes[1].controller.zoom(.9);assert.deepEqual(panes[0].controller.camera,leftCamera);comparison.endInteraction(panes[1]);await until(()=>!panes[1].needSurface);
// A new right filter interrupts a long left volume, updates only the right
// cache/settings, then resumes the left complete frame with its original settings.
delay=20;comparison.invalidate(panes[0]);await until(()=>heavyPending===1);const eventStart=comparisonEvents.length;
comparison.setSettings(panes[1],{porosityFilter:true,porosityMin:24,porosityMax:30,edges:false,clipAxis:1,clip:38});
assert.equal(panes[0].settings.porosityFilter,false);assert.equal(panes[0].settings.edges,true);assert.equal(panes[0].settings.clipAxis,0);
delay=0;await until(()=>!panes[0].needVolume&&!panes[1].needSurface);
const after=comparisonEvents.slice(eventStart);assert(after.findIndex(e=>e.id==='surface'&&e.phase==='surface-only')<after.findIndex(e=>e.id==='volume'&&e.phase==='ready'),'Right surface starved behind volume');
assert.equal(panes[0].front.texture.flags[2],1);assert.equal(panes[1].surface.key,surfaceKey(panes[1].settings,geometry));
const oldRightImage=panes[1].front;comparison.setQuality(panes[1],'detail');await until(()=>!panes[1].needSurface);assert.notEqual(panes[1].front,oldRightImage,'Surface quality change reused the old resolution');
const opaqueCompareComputes=computes.length;
comparison.setSettings(panes[0],{density:100,porosityFilter:true,porosityMin:18,porosityMax:25,clipAxis:3,clip:38});
comparison.setSettings(panes[1],{density:100,surfaceTransparency:65});
await until(()=>!panes[0].needVolume&&!panes[1].needSurface);
assert.equal(computes.length,opaqueCompareComputes,'Filtered opaque comparison still traced internal volume');
assert.equal(panes[0].surface.key,surfaceKey(panes[0].settings,geometry));
assert.equal(panes[1].settings.surfaceTransparency,65,'Left density overrode right opacity');
assert(comparisonEvents.some(e=>e.id==='volume'&&e.phase==='opaque-ready'));
const bothImages=panes.map(p=>p.front.texture),bothBuffers=panes.map(p=>p.surface.buffer);await comparison.dispose();
assert(bothImages.every(t=>t.dead));assert(bothBuffers.every(b=>b.dead));assert(deviceDestroyed);assert.deepEqual(comparisonErrors,[]);
console.log('PASS production comparison: one geometry upload, two retained images, independent filters/sections, linked cameras, surface priority and complete disposal');
