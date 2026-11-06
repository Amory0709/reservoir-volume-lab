import {ExplicitVolumeRenderer} from './explicit-renderer.js';
import {countExplicitMatches} from './explicit-grid.js';
import {surfaceKey} from './surface-cache.js';
import {volumeTiles,MAX_VOLUME_TILE_PIXELS} from './volume-tiles.js';
import {tgpu,d} from './vendor/typegpu.js';
import {webgpuUniformFields,webgpuComputeShader,webgpuSurfaceShader,webgpuPresentShader} from './webgpu-shaders.js';
import {gridTextureSources,gridLayoutEntries,frameValues} from './webgpu-resources.js';

const colorAttachment=(texture,loadOp='load')=>({view:texture.createView(),loadOp,storeOp:'store',clearValue:[0,0,0,0]});
const typedFrame=d.struct(Object.fromEntries(webgpuUniformFields.map(name=>[name,['dimensions','counts','flags','style','tile'].includes(name)?d.vec4u:name==='splits'?d.vec4i:d.vec4f])));

class GPUSurface{
  constructor(device){this.device=device;this.key=null;this.bytes=0;this.batches=[];this.batchFaces=32768;this.transparencySupported=true;}
  upload(data){
    const bytes=data.faces.byteLength+data.caps.byteLength;
    if(bytes>this.device.limits.maxBufferSize)throw new Error('表皮缓存超过此设备的缓冲区上限，请缩小数据规模。');
    this.buffer?.destroy();this.buffer=this.device.createBuffer({label:'Cached surface cells',size:Math.max(4,bytes),usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});
    if(data.faces.length)this.device.queue.writeBuffer(this.buffer,0,data.faces);
    if(data.caps.length)this.device.queue.writeBuffer(this.buffer,data.faces.byteLength,data.caps);
    let offset=0;this.batches=[];
    data.groups.forEach((count,i)=>{if(count)this.batches.push({offset,count,vertices:(i+1)*6,packed:1});offset+=count;});
    if(data.caps.length)this.batches.push({offset:data.faces.length,count:data.caps.length,vertices:6,packed:0});
    this.bytes=bytes;this.key=data.key;
  }
  dispose(){this.buffer?.destroy();}
}

export class WebGPUVolumeRenderer extends ExplicitVolumeRenderer{
  async initialize(){
    if(!navigator.gpu)throw new Error('当前浏览器未开放 WebGPU。请用支持 WebGPU 的浏览器并启用硬件加速，或点击“返回 WebGL2”。');
    this.adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
    if(!this.adapter)throw new Error('未找到可用的 WebGPU 适配器。请启用硬件加速，或返回 WebGL2。');
    const sources=gridTextureSources(this.volume),requiredLimits={};
    for(const dimension of ['3d','2d']){
      const key=dimension==='3d'?'maxTextureDimension3D':'maxTextureDimension2D';
      const needed=Math.max(...sources.filter(s=>s.dimension===dimension).flatMap(s=>s.size),dimension==='2d'?4096:256);
      if(needed>this.adapter.limits[key])throw new Error('网格纹理超过此 WebGPU 设备的尺寸上限，请选择较小规模。');
      requiredLimits[key]=Math.max(needed,Math.min(dimension==='3d'?2048:8192,this.adapter.limits[key]));
    }
    const features=this.adapter.features.has('timestamp-query')?['timestamp-query']:[];
    this.device=await this.adapter.requestDevice({requiredLimits,requiredFeatures:features});
    const device=this.device;
    device.lost.then(info=>{if(!this.disposed){this.lost=true;this.invalidate();this.onError(new Error('WebGPU 设备已中断：'+info.message+'。请重新加载或降低网格规模。'));}});
    device.addEventListener('uncapturederror',event=>{event.preventDefault();if(!this.disposed&&!this.lost){this.lost=true;this.invalidate();this.onError(new Error('WebGPU：'+event.error.message));}});
    this.context=this.canvas.getContext('webgpu');if(!this.context)throw new Error('无法创建 WebGPU 画布，请重新加载页面。');
    this.canvasFormat=navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({device,format:this.canvasFormat,alphaMode:'opaque'});this.clearBackground();
    this.root=tgpu.initFromDevice({device});this.frameBuffer=this.root.createBuffer(typedFrame).$usage('uniform');
    this.gridLayout=device.createBindGroupLayout({entries:gridLayoutEntries()});
    this.outputLayout=device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.COMPUTE,storageTexture:{access:'write-only',format:'rgba8unorm'}}]});
    this.resolveLayout=device.createBindGroupLayout({entries:[0,1].map(binding=>({binding,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'unfilterable-float'}}))});
    this.presentLayout=device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'float'}},{binding:1,visibility:GPUShaderStage.FRAGMENT,sampler:{type:'filtering'}}]});
    this.sampler=device.createSampler({minFilter:'linear',magFilter:'linear'});
    const uploadStart=performance.now();
    device.pushErrorScope('out-of-memory');device.pushErrorScope('validation');
    for(const source of sources){
      const [width,height,depthOrArrayLayers=1]=source.size;
      const texture=device.createTexture({label:source.key,dimension:source.dimension,size:{width,height,depthOrArrayLayers},format:source.format,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
      this.textures.push(texture);
      device.queue.writeTexture({texture},source.data,{bytesPerRow:width*source.bytes,rowsPerImage:height},{width,height,depthOrArrayLayers});
    }
    this.gridGroup=device.createBindGroup({layout:this.gridLayout,entries:[{binding:0,resource:{buffer:this.root.unwrap(this.frameBuffer)}},...this.textures.map((texture,i)=>({binding:i+1,resource:texture.createView()}))]});
    await this.waitForGpu();
    const validation=await device.popErrorScope(),memory=await device.popErrorScope();
    if(validation||memory)throw new Error('WebGPU 数据上传失败：'+(validation??memory).message);
    this.volume.stats.uploadMs=performance.now()-uploadStart;
    // The worker owns the CPU copies after the upload; GPU textures stay resident.
    this.afterTextureUpload();
    for(const key of ['attributes','vertices','nodes','ranges','columnPillars','kInterfaces'])this.volume[key]=null;
    await this.createPipelines();
    if(features.length){
      this.timestamps=device.createQuerySet({type:'timestamp',count:2});
      this.timestampResolve=device.createBuffer({size:16,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC});
      this.timestampRead=device.createBuffer({size:16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    }
    this.surface=await this.createSurfaceCache();await this.surfaceInitPromise;
    if(!this.surfaceDisabled){
      const ready=new Promise(resolve=>this.resolveSurfacePreload=resolve);
      this.ensureSurface({porosityFilter:false,porosityMin:0,porosityMax:100,clipAxis:0,clip:0});await ready;
    }
    this.resizeObserver=new ResizeObserver(()=>this.requestRender());this.resizeObserver.observe(this.canvas);
    this.events=new AbortController();this.bindInput(this.events.signal);return this;
  }
  async createSurfaceCache(){return new GPUSurface(this.device);}
  async createPipelines(){
    const device=this.device;
    const modules=[webgpuComputeShader,webgpuSurfaceShader,webgpuPresentShader].map(code=>device.createShaderModule({code}));
    for(const module of modules){const info=await module.getCompilationInfo();const errors=info.messages.filter(m=>m.type==='error');if(errors.length)throw new Error('WebGPU 着色器编译失败：'+errors.map(m=>m.message).join('\n'));}
    const [compute,surface,present]=modules;
    const layout=device.createPipelineLayout({bindGroupLayouts:[this.gridLayout]});
    this.compute=await device.createComputePipelineAsync({layout:device.createPipelineLayout({bindGroupLayouts:[this.gridLayout,this.outputLayout]}),compute:{module:compute,entryPoint:'computeMain'}});
    const vertexBuffers=[{arrayStride:4,stepMode:'instance',attributes:[{shaderLocation:0,offset:0,format:'uint32'}]}];
    this.surfacePipelines={};
    for(const transparent of [false,true])for(const packed of [false,true]){
      const blend={color:{srcFactor:'one',dstFactor:'one',operation:'add'},alpha:{srcFactor:'one',dstFactor:'one',operation:'add'}};
      this.surfacePipelines[`${+transparent}:${+packed}`]=await device.createRenderPipelineAsync({
        layout,vertex:{module:surface,entryPoint:packed?'packedVertex':'capVertex',buffers:vertexBuffers},
        fragment:{module:surface,entryPoint:transparent?'transparentFragment':'opaqueFragment',targets:transparent?[{format:'rgba16float',blend},{format:'r16float',blend}]:[{format:'rgba8unorm'}]},
        primitive:{topology:'triangle-list',cullMode:'none'},
        ...(!transparent?{depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'greater-equal'}}:{})
      });
    }
    this.background=await device.createRenderPipelineAsync({layout,vertex:{module:surface,entryPoint:'fullscreen'},fragment:{module:surface,entryPoint:'backgroundFragment',targets:[{format:'rgba8unorm'}]}});
    this.resolve=await device.createRenderPipelineAsync({layout:device.createPipelineLayout({bindGroupLayouts:[this.gridLayout,this.resolveLayout]}),vertex:{module:surface,entryPoint:'fullscreen'},fragment:{module:surface,entryPoint:'resolveFragment',targets:[{format:'rgba8unorm'}]}});
    this.presentation=await device.createRenderPipelineAsync({layout:device.createPipelineLayout({bindGroupLayouts:[this.presentLayout]}),vertex:{module:present,entryPoint:'fullscreen'},fragment:{module:present,entryPoint:'presentFragment',targets:[{format:this.canvasFormat}]}});
  }
  getImportLimits(){return {max3d:this.adapter.limits.maxTextureDimension3D,max2d:this.adapter.limits.maxTextureDimension2D};}
  clearBackground(){
    if(!this.device||!this.context||this.disposed||this.lost)return;
    const light=this.settings?.lightMode??(this.canvas.ownerDocument?.documentElement.dataset.theme==='light');
    const encoder=this.device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[{view:this.context.getCurrentTexture().createView(),loadOp:'clear',storeOp:'store',clearValue:light?[.93,.95,.97,1]:[.05,.08,.11,1]}]});pass.end();this.device.queue.submit([encoder.finish()]);
  }
  prepareFrame(cap){
    if(!this.settings||this.lost||this.disposed)return;
    const rect=this.canvas.getBoundingClientRect();if(rect.width<1||rect.height<1)return;
    const sizeFor=limit=>{const scale=Math.min(window.devicePixelRatio||1,2,Math.sqrt(limit/(rect.width*rect.height)),this.device.limits.maxTextureDimension2D/Math.max(rect.width,rect.height));return {width:Math.max(1,Math.round(rect.width*scale)),height:Math.max(1,Math.round(rect.height*scale))};};
    const size=sizeFor(cap),display=sizeFor(this.displayPixelCap);
    if(this.canvas.width!==display.width||this.canvas.height!==display.height){this.canvas.width=display.width;this.canvas.height=display.height;this.present(this.front);}
    if(!this.modified)this.camera.distance=10.2/Math.min(1,rect.width/rect.height);
    this.frameValues=frameValues(this.volume,this.settings,this.basis(),size,size.width/rect.width,countExplicitMatches(this.volume,this.settings)===0);
    this.writeFrame();return size;
  }
  writeFrame(){
    // TypeGPU validates and packs the shared, explicitly aligned WGSL uniform.
    this.frameBuffer.write(Object.fromEntries(Object.entries(this.frameValues).map(([key,value])=>[key,typedFrame.propTypes[key](...value)])));
  }
  createTarget(width,height){
    const texture=this.device.createTexture({size:[width,height],format:'rgba8unorm',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING});
    return {texture,width,height};
  }
  deleteTarget(target){if(target){target.texture.destroy();target.depth?.destroy();}}
  present(target){
    if(this.disposed||this.lost)return;if(!target||!this.presentation){this.clearBackground();return;}
    target.presentGroup??=this.device.createBindGroup({layout:this.presentLayout,entries:[{binding:0,resource:target.texture.createView()},{binding:1,resource:this.sampler}]});
    const encoder=this.device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[{view:this.context.getCurrentTexture().createView(),loadOp:'clear',storeOp:'store',clearValue:[0,0,0,1]}]});
    pass.setPipeline(this.presentation);pass.setBindGroup(0,target.presentGroup);pass.draw(3);pass.end();this.device.queue.submit([encoder.finish()]);
  }
  async waitForGpu(){await this.device.queue.onSubmittedWorkDone();}
  async renderFrame({preview},cancelled){
    if(cancelled()||this.disposed||this.lost||!this.settings)return false;
    this.ensureSurface(this.settings);
    const settings=this.settings,key=surfaceKey(settings,this.volume);
    if((preview||!this.benchmarking||this.isOpaqueVolume())&&this.surface&&!this.surfaceDisabled){
      if(this.surfacePending?.key===key){try{this.surface.upload(this.surfacePending);this.volume.stats.surfaceGpuBytes=this.surface.bytes;this.surfacePending=null;}catch(error){this.disableSurface(error.message);}}
      if(!preview&&!this.surfaceDisabled&&this.surface.key!==key){this.onMetrics({phase:'surface-pending'});return false;}
      if(!this.surfaceDisabled&&this.surface.key===key){
        if(preview||settings.surfaceOnly||this.isOpaqueVolume()){if(this.frontViewStamp===this.surfaceViewStamp()){this.onMetrics({phase:this.surfacePhase()});return true;}return this.renderSurface(cancelled);}
        if(this.frontViewStamp!==this.surfaceViewStamp())await this.renderSurface(cancelled);
        if(cancelled()||this.disposed||this.lost)return false;
      }
    }
    const size=this.prepareFrame(preview?this.previewPixels:({fast:240000,balanced:520000,detail:1200000}[this.quality]??520000));if(!size)return false;
    const start=performance.now(),{width,height}=size,back=this.createTarget(width,height);this.back=back;
    const output=this.device.createBindGroup({layout:this.outputLayout,entries:[{binding:0,resource:back.texture.createView()}]});
    this.frameValues.counts[3]=+preview;
    let budget=preview?this.previewTilePixels:Math.min(this.tilePixels,8192),pixels=0,batches=0,costPerPixel=0,gpuMs=0,lastReport=0;
    this.onMetrics({...size,phase:preview?'preview':'refine',progress:0,progressive:false});
    try{
      for(const {x,y,w,h} of volumeTiles(width,height,()=>budget)){
        if((!preview&&cancelled())||this.disposed||this.lost||this.settings!==settings||(preview&&this.surfacePending?.key===key))return false;
        this.frameValues.tile=[x,y,w,h];this.writeFrame();
        const submitted=performance.now(),encoder=this.device.createCommandEncoder();
        const pass=encoder.beginComputePass(this.timestamps?{timestampWrites:{querySet:this.timestamps,beginningOfPassWriteIndex:0,endOfPassWriteIndex:1}}:{});
        pass.setPipeline(this.compute);pass.setBindGroup(0,this.gridGroup);pass.setBindGroup(1,output);pass.dispatchWorkgroups(Math.ceil(w/8),Math.ceil(h/8));pass.end();
        if(this.timestamps){encoder.resolveQuerySet(this.timestamps,0,2,this.timestampResolve,0);encoder.copyBufferToBuffer(this.timestampResolve,0,this.timestampRead,0,16);}
        this.device.queue.submit([encoder.finish()]);await this.waitForGpu();
        let measured=performance.now()-submitted;
        if(this.timestamps&&!this.disposed&&!this.lost){
          await this.timestampRead.mapAsync(GPUMapMode.READ);
          try{const values=new BigUint64Array(this.timestampRead.getMappedRange());measured=Number(values[1]-values[0])/1e6;gpuMs+=measured;}finally{this.timestampRead.unmap();}
        }
        if((!preview&&cancelled())||this.disposed||this.lost||this.settings!==settings)return false;
        pixels+=w*h;batches++;
        if(this.timestamps||w*h>=budget*.5||measured>16){costPerPixel=Math.max(Math.max(.05,measured)/(w*h),costPerPixel*.95);budget=Math.max(256,Math.min(MAX_VOLUME_TILE_PIXELS,Math.max(budget/2,Math.min(budget*1.5,8/costPerPixel))));}
        if(preview)this.previewTilePixels=budget;else this.tilePixels=budget;
        if(!cancelled()&&performance.now()-lastReport>200){lastReport=performance.now();this.onMetrics({...size,phase:preview?'preview':'refine',progress:pixels/(width*height),progressive:false});}
      }
      this.present(back);const old=this.front;this.front=back;this.back=null;this.frontViewStamp=null;this.deleteTarget(old);
      this.gpuMs=this.timestamps?gpuMs:null;
      if(preview)this.previewPixels=Math.round(Math.max(3000,Math.min(16000,this.previewPixels*Math.min(1.5,50/Math.max(1,performance.now()-start)))));
      if(!cancelled())this.onMetrics({...size,gpuMs:this.gpuMs,volumeMs:performance.now()-start,batches,timerAvailable:!!this.timestamps,phase:preview?'preview-ready':this.isOpaqueVolume()?'opaque-ready':'ready',progress:1,surfaceReady:!this.surfaceDisabled&&this.surface?.key===key});
      return true;
    }finally{if(this.back===back){this.deleteTarget(back);this.back=null;}}
  }
  async renderSurface(cancelled){
    const size=this.prepareFrame(this.displayPixelCap);if(!size)return false;
    const settings=this.settings,surface=this.surface,device=this.device,start=performance.now(),stamp=this.surfaceViewStamp();
    const opacity=this.frameValues.boundsMax[3],drawFaces=opacity>0||settings.edges,transparent=opacity<1&&drawFaces;
    const back=this.createTarget(size.width,size.height);this.back=back;const temporary=[];
    const makeTexture=format=>{const texture=device.createTexture({size:[size.width,size.height],format,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});temporary.push(texture);return texture;};
    try{
      let attachments,depth;
      const encoder=device.createCommandEncoder();
      if(transparent){attachments=[makeTexture('rgba16float'),makeTexture('r16float')];const pass=encoder.beginRenderPass({colorAttachments:attachments.map(t=>colorAttachment(t,'clear'))});pass.end();}
      else{
        attachments=[back.texture];depth=makeTexture('depth32float');
        const pass=encoder.beginRenderPass({colorAttachments:[colorAttachment(back.texture,'clear')]});pass.setPipeline(this.background);pass.setBindGroup(0,this.gridGroup);pass.draw(3);pass.end();
        const clear=encoder.beginRenderPass({colorAttachments:[],depthStencilAttachment:{view:depth.createView(),depthLoadOp:'clear',depthStoreOp:'store',depthClearValue:0}});clear.end();
      }
      device.queue.submit([encoder.finish()]);await this.waitForGpu();
      this.onMetrics({...size,phase:'surface',progress:0});
      for(const batch of drawFaces?surface.batches:[])for(let local=0;local<batch.count;){
        // Finish a moving shell to avoid starvation; settings changes cancel it.
        if(this.disposed||this.lost||this.settings!==settings)return false;
        const count=Math.min(batch.count-local,Math.max(1,Math.floor(surface.batchFaces/(batch.vertices/6)))),submitted=performance.now();
        const commands=device.createCommandEncoder(),pass=commands.beginRenderPass({colorAttachments:attachments.map(t=>colorAttachment(t)),...(!transparent?{depthStencilAttachment:{view:depth.createView(),depthLoadOp:'load',depthStoreOp:'store'}}:{})});
        pass.setPipeline(this.surfacePipelines[`${+transparent}:${batch.packed}`]);pass.setBindGroup(0,this.gridGroup);pass.setVertexBuffer(0,surface.buffer);pass.draw(batch.vertices,count,0,batch.offset+local);pass.end();device.queue.submit([commands.finish()]);await this.waitForGpu();
        surface.batchFaces=Math.max(2048,Math.min(131072,surface.batchFaces*Math.max(.5,Math.min(1.5,8/Math.max(.1,performance.now()-submitted)))));local+=count;
      }
      if(this.disposed||this.lost||this.settings!==settings)return false;
      if(transparent){
        const commands=device.createCommandEncoder(),pass=commands.beginRenderPass({colorAttachments:[colorAttachment(back.texture,'clear')]});
        const group=device.createBindGroup({layout:this.resolveLayout,entries:attachments.map((texture,binding)=>({binding,resource:texture.createView()}))});
        pass.setPipeline(this.resolve);pass.setBindGroup(0,this.gridGroup);pass.setBindGroup(1,group);pass.draw(3);pass.end();device.queue.submit([commands.finish()]);await this.waitForGpu();
      }
      if(this.disposed||this.lost||this.settings!==settings)return false;
      this.present(back);const old=this.front;this.front=back;this.back=null;this.frontViewStamp=stamp;this.deleteTarget(old);
      if(!cancelled())this.onMetrics({...size,phase:this.surfacePhase(),progress:1,surfaceMs:performance.now()-start,surfaceGpuBytes:surface.bytes,surfaceCpuBytes:this.volume.stats.surfaceCpuBytes});return true;
    }finally{temporary.forEach(t=>t.destroy());if(this.back===back){this.deleteTarget(back);this.back=null;}}
  }
  async benchmark(){
    if(this.benchmarking)return null;this.invalidate();this.benchmarking=true;this.interacting=false;
    const original=this.camera.azimuth,times=[];let previous=null,start=null;
    try{
      while(!this.disposed&&!this.lost){
        const now=await new Promise(requestAnimationFrame);if(start===null)start=now;if(previous!==null)times.push(now-previous);previous=now;
        if(times.length>=12&&(now-start>=3000||times.length>=180))break;
        this.camera.azimuth=original+(now-start)*.00013;await this.draw();await this.waitForGpu();
      }
      if(this.disposed||this.lost)return null;
      const measured=times.slice(1),elapsed=measured.reduce((a,b)=>a+b,0);
      return {fps:measured.length*1000/elapsed,frames:measured.length,elapsedMs:elapsed,width:this.canvas.width,height:this.canvas.height,scale:this.volume.scale,quality:this.quality};
    }finally{this.benchmarking=false;this.camera.azimuth=original;if(!this.disposed)this.requestRender();}
  }
  dispose(){
    super.dispose();this.textures.forEach(t=>t.destroy());this.timestamps?.destroy();this.timestampResolve?.destroy();this.timestampRead?.destroy();
    this.frameBuffer?.destroy();this.root?.destroy();this.context?.unconfigure();this.device?.destroy();
  }
}
