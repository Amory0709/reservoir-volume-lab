import {LargeVolumeRenderer} from './large-renderer.js';
import {explicitFragmentShader} from './explicit-shaders.js';
import {withBlockTraversal} from './block-shader.js';
import {explicitPorosityRange,countExplicitMatches} from './explicit-grid.js';
import {LatestRenderQueue} from './render-queue.js';
import {SurfaceRaster} from './surface-raster.js';
import {surfaceKey,surfaceFilterKey} from './surface-cache.js';
import {volumeTiles,volumePatch,MAX_VOLUME_TILE_PIXELS} from './volume-tiles.js';
import {GpuYield} from './gpu-yield.js';

export class ExplicitVolumeRenderer extends LargeVolumeRenderer{
  constructor(...args){
    super(...args);this.fragmentSource=withBlockTraversal(explicitFragmentShader);this.requestVersion=0;this.filterTimer=0;
    this.tilePixels=1024;this.previewTilePixels=4096;this.previewPixels=12000;this.front=null;this.back=null;
    this.queue=new LatestRenderQueue((job,cancelled)=>this.renderFrame(job,cancelled));
    this.displayPixelCap=2000000;this.surfaceRequestedKey=null;this.surfacePending=null;
  }
  afterTextureUpload(){
    const v=this.volume;
    if(v.blockIndex)for(const key of ['data','ranges','leaves'])v.blockIndex[key]=null;
    this.surfaceInitPromise=new Promise(resolve=>this.resolveSurfaceInit=resolve);
    try{
      this.surfaceWorker=new Worker(new URL('./surface-worker.js',import.meta.url),{type:'module'});
      this.surfaceWorker.onmessage=({data})=>{
        if(this.disposed)return;
        if(data.type==='error'){this.disableSurface(data.message);return;}
        if(data.cpuBytes)this.volume.stats.surfaceCpuBytes=data.cpuBytes;
        if(data.type==='initialized'){this.resolveSurfaceInit?.();this.resolveSurfaceInit=null;return;}
        if(data.type!=='surface'||data.key!==this.surfaceRequestedKey)return;
        this.surfacePending=data;
        if(this.resolveSurfacePreload){this.resolveSurfacePreload();this.resolveSurfacePreload=null;return;}
        // A finished volume is not proof that its rotation cache is ready.
        // Always install the latest cache and present its shell at a GPU boundary.
        if(this.settings&&!this.benchmarking)this.requestRender(this.interacting);
      };
      this.surfaceWorker.onerror=()=>this.disableSurface('表面缓存工作线程不可用');
      const keys=['attributes','nodes','columnPillars','kInterfaces'],source={dims:v.dims,nodeCount:v.nodeCount,splitsX:v.splitsX,splitY:v.splitY};
      keys.forEach(k=>source[k]=v[k]);
      this.surfaceWorker.postMessage({type:'init',volume:source},keys.filter(k=>v[k]).map(k=>v[k].buffer));
    }catch(error){this.disableSurface(error.message);}
  }
  disableSurface(reason){
    console.warn('Surface cache:',reason);this.surfaceDisabled=true;this.surfaceWorker?.terminate();this.surfaceWorker=null;
    this.surfacePending=null;this.resolveSurfaceInit?.();this.resolveSurfaceInit=null;this.resolveSurfacePreload?.();this.resolveSurfacePreload=null;
    if(this.settings&&!this.disposed)queueMicrotask(()=>this.requestRender(this.interacting));
  }
  async initialize(){
    await super.initialize();
    if(!this.surfaceDisabled){
      try{
        this.surface=await this.createSurfaceCache();await this.surfaceInitPromise;
        if(!this.surfaceDisabled){
          const ready=new Promise(resolve=>this.resolveSurfacePreload=resolve);
          this.ensureSurface({porosityFilter:false,porosityMin:0,porosityMax:100,clipAxis:0,clip:0});await ready;
        }
      }catch(error){this.disableSurface(error.message);this.surface?.dispose();this.surface=null;}
    }
    return this;
  }
  async createSurfaceCache(){const surface=new SurfaceRaster(this);try{await surface.initialize();return surface;}catch(error){surface.dispose();throw error;}}
  ensureSurface(s){
    if(!s||!this.surfaceWorker||this.surfaceDisabled)return;
    const key=surfaceKey(s,this.volume);if(key===this.surfaceRequestedKey)return;
    this.surfaceRequestedKey=key;this.surfacePending=null;
    const a=Math.max(0,s.clipAxis-1),v=this.volume;
    this.surfaceWorker.postMessage({type:'build',key,filterKey:surfaceFilterKey(s,v),axis:s.clipAxis,position:Math.fround(v.bounds.max[a]-(v.bounds.max[a]-v.bounds.min[a])*s.clip/100)});
  }
  textureSources(gl){const v=this.volume;let index=v.blockIndex;
    const limit=gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if(index&&(index.ranges.length/4096>limit||index.leaves.length/2048>limit))index=null;
    this.blockCount=index?.count??0;this.blockIndexBytes=index?.bytes??0;
    v.stats.gpuBytes+=this.blockIndexBytes;
    return [
    ['uVertices',gl.TEXTURE_3D,v.nodeDims,v.vertices,gl.RGBA32F,gl.RGBA,gl.FLOAT],
    ['uAttributes',gl.TEXTURE_3D,v.dims,v.attributes,gl.RGBA32F,gl.RGBA,gl.FLOAT],
    ['uNodes',gl.TEXTURE_2D,[v.nodeWidth,v.nodeHeight],v.nodes,gl.RGBA32F,gl.RGBA,gl.FLOAT],
    ['uRanges',gl.TEXTURE_2D,[v.nodeWidth,v.rangeHeight],v.ranges,gl.RG32F,gl.RG,gl.FLOAT],
    // Integer samplers need their own compatible texture units even in the
    // synthetic shader branch; provide tiny placeholders for demo models.
    ['uColumnPillars',gl.TEXTURE_2D,v.columnPillars?v.dims.slice(0,2):[1,1],v.columnPillars??new Uint32Array(4),gl.RGBA32UI,gl.RGBA_INTEGER,gl.UNSIGNED_INT],
    ['uKInterfaces',gl.TEXTURE_2D,v.kInterfaces?[v.dims[2],1]:[1,1],v.kInterfaces??new Uint32Array(2),gl.RG32UI,gl.RG_INTEGER,gl.UNSIGNED_INT],
    ['uBlockData',gl.TEXTURE_2D,index?[512,1]:[1,1],index?.data??new Float32Array(4),gl.RGBA32F,gl.RGBA,gl.FLOAT,true],
    ['uBinRanges',gl.TEXTURE_2D,index?[2048,index.ranges.length/4096]:[1,1],index?.ranges??new Uint32Array(2),gl.RG32UI,gl.RG_INTEGER,gl.UNSIGNED_INT,true],
    ['uBinLeaves',gl.TEXTURE_2D,index?[2048,index.leaves.length/2048]:[1,1],index?.leaves??new Uint32Array(1),gl.R32UI,gl.RED_INTEGER,gl.UNSIGNED_INT,true]
  ];}
  onOptionalTextureFailure(){this.volume.stats.gpuBytes-=this.blockIndexBytes;this.blockIndexBytes=0;this.blockCount=0;}
  setGridUniforms(){const {gl,uniforms:u,volume:v}=this;
    for(const name of ['uBlockCount','uBlockTraversal','uFastConnections'])u[name]=gl.getUniformLocation(this.program,name);
    gl.uniform1i(u.uBlockCount,this.blockCount??0);
    gl.uniform3iv(u.uSplits,v.splitsX);gl.uniform1i(u.uNodeWidth,v.nodeWidth);gl.uniform1i(u.uNodeCount,v.nodeCount);gl.uniform1i(u.uCellCount,v.stats.cells);
    gl.uniform1i(u.uImported,v.synthetic===false?1:0);
  }
  setPhi(s){
    this.gl.uniform2f(this.uniforms.uPhi,...explicitPorosityRange(s.porosityMin,s.porosityMax));
    // A zero-width or otherwise empty range must never search the whole tree.
    this.gl.uniform1i(this.uniforms.uNoMatches,countExplicitMatches(this.volume,s)===0?1:0);
    if(this.volume.propertyInfo){const p=this.volume.propertyInfo[s.property];this.gl.uniform2f(this.uniforms.uPropertyRange,p.min,p.max);this.gl.uniform1i(this.uniforms.uPropertyLog,p.log?1:0);}
    const enabled=s.blockTraversal!==false;
    this.gl.uniform1i(this.uniforms.uFastConnections,enabled?1:0);
    // Selective filters benefit from the BVH's property range hierarchy.
    this.gl.uniform1i(this.uniforms.uBlockTraversal,enabled&&this.blockCount>0&&countExplicitMatches(this.volume,s)===this.volume.stats.activeCells?1:0);
    // Surface OIT uses units 6/7; restore all spatial-index bindings per frame.
    for(let unit=6;unit<9;unit++)if(this.textures[unit]){this.gl.activeTexture(this.gl.TEXTURE0+unit);this.gl.bindTexture(this.gl.TEXTURE_2D,this.textures[unit]);}
  }
  invalidate(){
    this.requestVersion++;this.queue.cancel();cancelAnimationFrame(this.frame);this.frame=0;
    clearTimeout(this.refineTimer);clearTimeout(this.filterTimer);
  }
  setSettings(settings,interacting=false){
    const old=this.settings,filterChanged=old&&(old.porosityFilter!==settings.porosityFilter||old.porosityMin!==settings.porosityMin||old.porosityMax!==settings.porosityMax);
    this.settings={...settings};
    if(filterChanged||old?.density!==settings.density)this.tilePixels=Math.min(this.tilePixels,1024);
    if(filterChanged&&interacting){
      this.invalidate();this.onMetrics({phase:'pending'});
      // Update controls/counts immediately; merge slider events before GPU work.
      this.filterTimer=setTimeout(()=>this.requestRender(true),120);
    }else this.requestRender(interacting);
  }
  requestRender(interacting=false){
    if(this.benchmarking||this.disposed||this.lost)return;
    this.ensureSurface(this.settings);this.invalidate();this.interacting=interacting;const version=this.requestVersion;
    this.onMetrics({phase:'pending'});
    this.frame=requestAnimationFrame(()=>{
      this.frame=0;
      this.queue.request({preview:true}).then(done=>{
        if(!done||version!==this.requestVersion||this.benchmarking||this.disposed)return;
        if(!interacting)this.requestRefinement(version);
      }).catch(error=>this.onError(error));
    });
    // Measure wheel/keyboard quiet time from the last input, not from the end
    // of its preview. A slow preview may finish, then the refinement follows.
    if(interacting)this.refineTimer=setTimeout(()=>this.requestRefinement(version),80);
  }
  requestRefinement(version){
    if(version!==this.requestVersion||this.benchmarking||this.disposed||this.lost)return;
    cancelAnimationFrame(this.frame);this.frame=0;clearTimeout(this.refineTimer);
    this.interacting=false;
    this.queue.request({preview:false}).catch(error=>this.onError(error));
  }
  endInteraction(){
    if(this.benchmarking||this.disposed||this.lost)return;
    // Release already identifies the final camera. Skip another low-res frame
    // and start at the next safe GPU boundary, without an artificial timeout.
    this.invalidate();this.requestRefinement(this.requestVersion);
  }
  draw(){
    // Used by initial load and the benchmark. Benchmark awaits actual completion.
    this.invalidate();return this.queue.request({preview:false});
  }
  async drawInitial(){
    this.ensureSurface(this.settings);this.invalidate();const version=this.requestVersion;
    await this.queue.request({preview:true});this.requestRefinement(version);
  }
  createTarget(width,height){
    const gl=this.gl,texture=gl.createTexture(),fbo=gl.createFramebuffer();
    gl.activeTexture(gl.TEXTURE0+9);gl.bindTexture(gl.TEXTURE_2D,texture);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
    gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);
    if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE){gl.deleteFramebuffer(fbo);gl.deleteTexture(texture);throw new Error('画面缓冲分配失败，请降低渲染分辨率。');}
    return {fbo,texture,width,height};
  }
  deleteTarget(target){if(target){this.gl.deleteFramebuffer(target.fbo);this.gl.deleteTexture(target.texture);if(target.depth)this.gl.deleteRenderbuffer(target.depth);}}
  present(target){
    const gl=this.gl;gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,null);
    if(target){
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER,target.fbo);
      gl.blitFramebuffer(0,0,target.width,target.height,0,0,this.canvas.width,this.canvas.height,gl.COLOR_BUFFER_BIT,gl.LINEAR);
    }else this.clearBackground();
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
  }
  presentVolumePatch(target,tile){
    const gl=this.gl,patch=volumePatch(tile,target.width,target.height,this.canvas.width,this.canvas.height);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER,target.fbo);gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,null);
    gl.enable(gl.SCISSOR_TEST);gl.scissor(patch.x,patch.y,patch.w,patch.h);
    // Keep one global sampling transform so adjacent patches cannot make seams.
    gl.blitFramebuffer(0,0,target.width,target.height,0,0,this.canvas.width,this.canvas.height,gl.COLOR_BUFFER_BIT,gl.LINEAR);
    gl.disable(gl.SCISSOR_TEST);gl.bindFramebuffer(gl.FRAMEBUFFER,null);
  }
  async waitForGpu(){
    const gl=this.gl,sync=gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0),start=performance.now();gl.flush();
    this.gpuYield??=new GpuYield();let polls=0;
    try{
      while(!this.lost&&!this.disposed){
        const status=gl.clientWaitSync(sync,0,0);
        if(status===gl.ALREADY_SIGNALED||status===gl.CONDITION_SATISFIED)return;
        if(status===gl.WAIT_FAILED)throw new Error('显卡同步失败，请重新加载。');
        if(performance.now()-start>10000)throw new Error('显卡响应超时，请选择较小规模重试。');
        // Yield to input and compositor; never spin or submit another tile here.
        // Occasionally sleep on long GPU work; between timers, posted tasks
        // reset timer nesting and leave input/compositing opportunities.
        if(++polls%8===0)await new Promise(resolve=>setTimeout(resolve,1));
        else await this.gpuYield.next();
      }
    }finally{gl.deleteSync(sync);}
  }
  async renderFrame({preview},cancelled){
    if(cancelled()||this.disposed||this.lost)return false;
    this.ensureSurface(this.settings);
    const settings=this.settings,key=settings&&surfaceKey(settings,this.volume);
    if((preview||!this.benchmarking||this.isOpaqueVolume())&&this.surface&&!this.surfaceDisabled){
      if(this.surfacePending?.key===key){
        try{this.surface.upload(this.surfacePending);this.volume.stats.surfaceGpuBytes=this.surface.bytes;this.surfacePending=null;}
        catch(error){this.disableSurface(error.message);}
      }
      if(!preview&&this.surfaceWorker&&!this.surfaceDisabled&&this.surface.key!==key){
        // Do not report processing complete (or start an expensive refinement)
        // before this filter/section has a reusable, sharp rotation surface.
        this.onMetrics({phase:'surface-pending'});return false;
      }
      if(!this.surfaceDisabled&&this.surface.key===key){
        if(preview||settings.surfaceOnly||this.isOpaqueVolume()){
          if(this.frontViewStamp===this.surfaceViewStamp()){
            this.onMetrics({phase:this.surfacePhase()});return true;
          }
          return this.renderSurface(cancelled);
        }
        // Release/quiet-time may supersede a queued preview. First show the
        // FINAL camera's shell, rather than freezing an older angle throughout
        // a long refinement. The same queue still owns every GPU submission.
        if(this.frontViewStamp!==this.surfaceViewStamp())await this.renderSurface(cancelled);
        if(cancelled()||this.disposed||this.lost)return false;
      }
    }
    // If the surface cache is unavailable, keep the original volume path.
    const targetCap=preview?this.previewPixels:({fast:240000,balanced:520000,detail:1200000}[this.quality]??240000);
    const size=this.prepareFrame(targetCap);if(!size)return false;
    const {width,height}=size,gl=this.gl,total=width*height,start=performance.now();
    const progressive=!preview&&!this.benchmarking&&settings.progressive===true&&!!this.front&&this.frontViewStamp===this.surfaceViewStamp();
    gl.uniform1i(this.uniforms.uSurfacePreview,preview?1:0);
    this.back=this.createTarget(width,height);const back=this.back;
    if(progressive){
      // Initialize ALL texels before any partial presentation. At tile borders,
      // bilinear taps then blend with the current shell, never undefined memory.
      gl.disable(gl.SCISSOR_TEST);gl.bindFramebuffer(gl.READ_FRAMEBUFFER,this.front.fbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,back.fbo);
      gl.blitFramebuffer(0,0,this.front.width,this.front.height,0,0,width,height,gl.COLOR_BUFFER_BIT,gl.LINEAR);
      gl.bindFramebuffer(gl.FRAMEBUFFER,back.fbo);
    }
    // Adapt within this frame so a conservative first batch does not force
    // hundreds of tiny submissions before the first sharp image can finish.
    // A new camera may be much more expensive than the previous one.
    let budget=preview?this.previewTilePixels:Math.min(this.tilePixels,8192);
    let pixels=0,batches=0,gpuMs=0,validTimer=!!this.timerExtension,lastReport=0,costPerPixel=0,patched=false;
    this.onMetrics({...size,phase:preview?'preview':'refine',progress:0,progressive,surfacePending:!!this.surfaceWorker&&this.surfaceRequestedKey===key});
    try{
      for(const tile of volumeTiles(width,height,()=>budget)){
        const {x,y,w:tw,h:th}=tile;
        // Let one small preview finish during continuous rotation; otherwise
        // cancelling at every pointer event starves presentation. Refinements
        // are cancelled after the current tile, and only the latest job follows.
        if((!preview&&cancelled())||this.disposed||this.lost||this.settings!==settings||
          (preview&&this.surfacePending?.key===key))return false;
        const submitted=performance.now();
        gl.bindFramebuffer(gl.FRAMEBUFFER,back.fbo);gl.enable(gl.SCISSOR_TEST);gl.scissor(x,y,tw,th);
        let query=null;
        if(this.timerExtension){query=gl.createQuery();gl.beginQuery(this.timerExtension.TIME_ELAPSED_EXT,query);}
        gl.drawArrays(gl.TRIANGLES,0,3);
        if(query)gl.endQuery(this.timerExtension.TIME_ELAPSED_EXT);
        try{
          await this.waitForGpu();
          if((!preview&&cancelled())||this.disposed||this.lost||this.settings!==settings)return false;
          pixels+=tw*th;batches++;
          // Only completed, still-current tiles may replace the sharp shell.
          // The preserved canvas needs no full-frame copy while each tile waits.
          if(progressive){this.presentVolumePatch(back,tile);patched=true;}
          let measured=performance.now()-submitted,gpuMeasured=false;
          if(query&&gl.getQueryParameter(query,gl.QUERY_RESULT_AVAILABLE)&&!gl.getParameter(this.timerExtension.GPU_DISJOINT_EXT)){
            const time=gl.getQueryParameter(query,gl.QUERY_RESULT)/1e6;gpuMs+=time;measured=time;gpuMeasured=true;
          }else validTimer=false;
          // Retain recent expensive samples; grow at most 1.5x per fence and
          // shrink promptly when a tile crosses into a denser part of the grid.
          // Tiny boundary strips mostly measure timer wake-up overhead when
          // device timing is unavailable. Do not poison the next large batch
          // with that per-pixel estimate; genuinely slow strips still shrink it.
          if(gpuMeasured||tw*th>=budget*.5||measured>16){
            costPerPixel=Math.max(Math.max(.05,measured)/(tw*th),costPerPixel*.95);
            const desired=16/costPerPixel;
            budget=Math.max(256,Math.min(MAX_VOLUME_TILE_PIXELS,Math.max(budget/2,Math.min(budget*1.5,desired))));
          }
          // Preview timing must never enlarge expensive full-volume batches.
          if(preview)this.previewTilePixels=budget;else this.tilePixels=budget;
        }finally{if(query)gl.deleteQuery(query);}
        if(!cancelled()&&performance.now()-lastReport>200){lastReport=performance.now();this.onMetrics({...size,phase:preview?'preview':'refine',progress:pixels/total,progressive});}
      }
      this.present(back);const old=this.front;this.front=back;this.back=null;this.frontViewStamp=null;this.deleteTarget(old);
      this.gpuMs=validTimer?gpuMs:null;
      if(preview){const elapsed=performance.now()-start;this.previewPixels=Math.round(Math.max(3000,Math.min(16000,this.previewPixels*Math.min(1.5,50/Math.max(1,elapsed)))));}
      if(!this.firstDrawValidated){if(gl.getError()!==gl.NO_ERROR)throw new Error('分块渲染失败，请重新加载。');this.firstDrawValidated=true;}
      if(!cancelled())this.onMetrics({...size,gpuMs:this.gpuMs,volumeMs:performance.now()-start,batches,timerAvailable:!!this.timerExtension,phase:preview?'preview-ready':this.isOpaqueVolume()?'opaque-ready':'ready',progress:1,surfaceReady:!this.surfaceDisabled&&this.surface?.key===key});
      return true;
    }finally{
      gl.disable(gl.SCISSOR_TEST);gl.bindFramebuffer(gl.FRAMEBUFFER,null);
      if(this.back===back){
        // A changed camera/filter/style must discard the mixed intermediate
        // view. Keep the complete shell until the next job presents its result.
        if(patched&&!this.disposed&&!this.lost)this.present(this.front);
        this.deleteTarget(back);this.back=null;
      }
    }
  }
  // 100 is a discrete opaque endpoint, not a finite extinction coefficient.
  isOpaqueVolume(){return !this.settings.surfaceOnly&&this.settings.density>=100;}
  surfacePhase(){return this.settings.surfaceOnly?'surface-only':this.isOpaqueVolume()?'opaque-ready':'surface-ready';}
  surfaceViewStamp(){const rect=this.canvas.getBoundingClientRect();return JSON.stringify([this.camera,this.settings,rect.width,rect.height,window.devicePixelRatio||1]);}
  async renderSurface(cancelled){
    const size=this.prepareFrame(this.displayPixelCap);if(!size)return false;
    const settings=this.settings,gl=this.gl,surface=this.surface,start=performance.now(),snapshot={settings:{...settings},basis:this.basis()},stamp=this.surfaceViewStamp();
    if(this.isOpaqueVolume())snapshot.settings.surfaceTransparency=0;
    const opacity=surface.transparencySupported?1-(snapshot.settings.surfaceTransparency??0)/100:1,drawFaces=opacity>0||settings.edges,transparent=opacity<1&&drawFaces,index=transparent?2:0;
    let back=null,transparencyTarget=null;
    try{
      this.back=this.createTarget(size.width,size.height);back=this.back;
      gl.disable(gl.SCISSOR_TEST);gl.disable(gl.DEPTH_TEST);gl.disable(gl.BLEND);
      surface.width=size.width;surface.height=size.height;
      if(transparent)transparencyTarget=surface.createTransparencyTarget(size.width,size.height);
      else{
        back.depth=gl.createRenderbuffer();gl.bindRenderbuffer(gl.RENDERBUFFER,back.depth);
        gl.renderbufferStorage(gl.RENDERBUFFER,gl.DEPTH_COMPONENT32F,size.width,size.height);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.RENDERBUFFER,back.depth);
        if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('表面深度缓冲分配失败');
        gl.depthMask(true);gl.clearDepth(0);gl.clear(gl.DEPTH_BUFFER_BIT);
        surface.bind(1,snapshot);gl.drawArrays(gl.TRIANGLES,0,3);
      }
      // One shared producer owns BOTH raster and ray work and waits every batch.
      await this.waitForGpu();if(this.disposed||this.lost)return false;
      surface.bind(index,snapshot);
      if(transparent){gl.enable(gl.BLEND);gl.blendEquation(gl.FUNC_ADD);gl.blendFunc(gl.ONE,gl.ONE);}
      else{gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.GEQUAL);}
      this.onMetrics({...size,phase:'surface',progress:0});
      for(const batch of drawFaces?surface.batches:[]){
       gl.uniform1i(surface.uniforms[index].uPacked,batch.packed);
       for(let local=0;local<batch.count;){
        // Camera motion may finish a shell to avoid starvation. Any display
        // setting change cancels it, including edges, width and property color.
        if(this.disposed||this.lost||this.settings!==settings)return false;
        const facesPerCell=batch.vertices/6,count=Math.min(batch.count-local,Math.max(1,Math.floor(surface.batchFaces/facesPerCell))),submitted=performance.now();
        gl.bindFramebuffer(gl.FRAMEBUFFER,transparencyTarget?.fbo??back.fbo);gl.bindBuffer(gl.ARRAY_BUFFER,surface.buffer);
        gl.vertexAttribIPointer(0,1,gl.UNSIGNED_INT,4,(batch.offset+local)*4);gl.drawArraysInstanced(gl.TRIANGLES,0,batch.vertices,count);
        await this.waitForGpu();
        const ms=Math.max(.1,performance.now()-submitted);
        surface.batchFaces=Math.max(2048,Math.min(131072,surface.batchFaces* Math.max(.5,Math.min(1.5,8/ms))));local+=count;
       }
      }
      if(this.disposed||this.lost||this.settings!==settings)return false;
      if(transparencyTarget){surface.resolveTransparency(transparencyTarget,back,snapshot);await this.waitForGpu();}
      if(this.disposed||this.lost||this.settings!==settings)return false;
      if(gl.getError()!==gl.NO_ERROR)throw new Error('表面渲染失败');
      this.present(back);const old=this.front;this.front=back;this.back=null;this.frontViewStamp=stamp;this.deleteTarget(old);
      if(!cancelled())this.onMetrics({...size,phase:this.surfacePhase(),progress:1,surfaceMs:performance.now()-start,surfaceGpuBytes:surface.bytes,surfaceCpuBytes:this.volume.stats.surfaceCpuBytes});
      return true;
    }catch(error){
      if(transparent){surface.transparencySupported=false;this.onMetrics({surfaceTransparencyUnavailable:true});queueMicrotask(()=>this.requestRender(this.interacting));}
      else this.disableSurface(error.message);
      return false;
    }
    finally{gl.disable(gl.BLEND);gl.disable(gl.DEPTH_TEST);gl.bindFramebuffer(gl.FRAMEBUFFER,null);surface.deleteTransparencyTarget?.(transparencyTarget);if(back&&this.back===back){this.deleteTarget(back);this.back=null;}}
  }
  async benchmark(){this.invalidate();return super.benchmark();}
  dispose(){
    this.gpuYield?.dispose();
    this.surfaceWorker?.terminate();this.resolveSurfaceInit?.();this.resolveSurfacePreload?.();this.surfacePending=null;this.surface?.dispose();
    this.invalidate();this.queue.dispose();this.deleteTarget(this.front);this.deleteTarget(this.back);this.front=this.back=null;
    super.dispose();
  }
}
