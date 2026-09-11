import {LargeVolumeRenderer} from './large-renderer.js';
import {explicitFragmentShader} from './explicit-shaders.js';
import {explicitPorosityRange,countExplicitMatches} from './explicit-grid.js';
import {LatestRenderQueue} from './render-queue.js';

export class ExplicitVolumeRenderer extends LargeVolumeRenderer{
  constructor(...args){
    super(...args);this.fragmentSource=explicitFragmentShader;this.requestVersion=0;this.filterTimer=0;
    this.tilePixels=1024;this.previewTilePixels=4096;this.previewPixels=12000;this.front=null;this.back=null;
    this.queue=new LatestRenderQueue((job,cancelled)=>this.renderFrame(job,cancelled));
  }
  textureSources(gl){const v=this.volume;return [
    ['uVertices',gl.TEXTURE_3D,v.nodeDims,v.vertices,gl.RGBA32F,gl.RGBA,gl.FLOAT],
    ['uAttributes',gl.TEXTURE_3D,v.dims,v.attributes,gl.RGBA32F,gl.RGBA,gl.FLOAT],
    ['uNodes',gl.TEXTURE_2D,[v.nodeWidth,v.nodeHeight],v.nodes,gl.RGBA32F,gl.RGBA,gl.FLOAT],
    ['uRanges',gl.TEXTURE_2D,[v.nodeWidth,v.rangeHeight],v.ranges,gl.RG32F,gl.RG,gl.FLOAT],
    // Integer samplers need their own compatible texture units even in the
    // synthetic shader branch; provide tiny placeholders for demo models.
    ['uColumnPillars',gl.TEXTURE_2D,v.columnPillars?v.dims.slice(0,2):[1,1],v.columnPillars??new Uint32Array(4),gl.RGBA32UI,gl.RGBA_INTEGER,gl.UNSIGNED_INT],
    ['uKInterfaces',gl.TEXTURE_2D,v.kInterfaces?[v.dims[2],1]:[1,1],v.kInterfaces??new Uint32Array(2),gl.RG32UI,gl.RG_INTEGER,gl.UNSIGNED_INT]
  ];}
  setGridUniforms(){const {gl,uniforms:u,volume:v}=this;
    gl.uniform3iv(u.uSplits,v.splitsX);gl.uniform1i(u.uNodeWidth,v.nodeWidth);gl.uniform1i(u.uNodeCount,v.nodeCount);gl.uniform1i(u.uCellCount,v.stats.cells);
    gl.uniform1i(u.uImported,v.synthetic===false?1:0);
  }
  setPhi(s){
    this.gl.uniform2f(this.uniforms.uPhi,...explicitPorosityRange(s.porosityMin,s.porosityMax));
    // A zero-width or otherwise empty range must never search the whole tree.
    this.gl.uniform1i(this.uniforms.uNoMatches,countExplicitMatches(this.volume,s)===0?1:0);
    if(this.volume.propertyInfo){const p=this.volume.propertyInfo[s.property];this.gl.uniform2f(this.uniforms.uPropertyRange,p.min,p.max);this.gl.uniform1i(this.uniforms.uPropertyLog,p.log?1:0);}
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
    this.invalidate();this.interacting=interacting;const version=this.requestVersion;
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
  createTarget(width,height){
    const gl=this.gl,texture=gl.createTexture(),fbo=gl.createFramebuffer();
    gl.activeTexture(gl.TEXTURE7);gl.bindTexture(gl.TEXTURE_2D,texture);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
    gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);
    if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE){gl.deleteFramebuffer(fbo);gl.deleteTexture(texture);throw new Error('画面缓冲分配失败，请降低渲染分辨率。');}
    return {fbo,texture,width,height};
  }
  deleteTarget(target){if(target){this.gl.deleteFramebuffer(target.fbo);this.gl.deleteTexture(target.texture);}}
  present(target){
    const gl=this.gl;gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,null);
    if(target){
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER,target.fbo);
      gl.blitFramebuffer(0,0,target.width,target.height,0,0,this.canvas.width,this.canvas.height,gl.COLOR_BUFFER_BIT,gl.LINEAR);
    }else{gl.clearColor(.05,.08,.11,1);gl.clear(gl.COLOR_BUFFER_BIT);}
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
  }
  async waitForGpu(){
    const gl=this.gl,sync=gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0),start=performance.now();gl.flush();
    try{
      while(!this.lost&&!this.disposed){
        const status=gl.clientWaitSync(sync,0,0);
        if(status===gl.ALREADY_SIGNALED||status===gl.CONDITION_SATISFIED)return;
        if(status===gl.WAIT_FAILED)throw new Error('显卡同步失败，请重新加载。');
        if(performance.now()-start>10000)throw new Error('显卡响应超时，请选择较小规模重试。');
        // Yield to input and compositor; never spin or submit another tile here.
        await new Promise(resolve=>setTimeout(resolve,0));
      }
    }finally{gl.deleteSync(sync);}
  }
  async renderFrame({preview},cancelled){
    if(cancelled()||this.disposed||this.lost)return false;
    const targetCap=preview?this.previewPixels:({fast:240000,balanced:520000,detail:1200000}[this.quality]??240000);
    const size=this.prepareFrame(targetCap);if(!size)return false;
    const {width,height}=size,gl=this.gl,total=width*height,start=performance.now();
    gl.uniform1i(this.uniforms.uSurfacePreview,preview?1:0);
    this.back=this.createTarget(width,height);const back=this.back;
    // Adapt within this frame so a conservative first batch does not force
    // hundreds of tiny submissions before the first sharp image can finish.
    let budget=preview?this.previewTilePixels:this.tilePixels;
    let pixels=0,gpuMs=0,validTimer=!!this.timerExtension,lastReport=0,costPerPixel=0;
    this.onMetrics({...size,phase:preview?'preview':'refine',progress:0});
    try{
      for(let y=0;y<height;){
        // Keep a row's height fixed while widths adapt: no gaps or overlaps.
        const th=Math.min(height-y,Math.max(16,Math.min(128,Math.floor(Math.sqrt(budget)))));
        for(let x=0;x<width;){
          // Let one small preview finish during continuous rotation; otherwise
          // cancelling at every pointer event starves presentation. Refinements
          // are cancelled after the current tile, and only the latest job follows.
          if((!preview&&cancelled())||this.disposed||this.lost)return false;
          const tw=Math.min(width-x,Math.max(1,Math.min(128,Math.floor(budget/th)))),submitted=performance.now();
          gl.bindFramebuffer(gl.FRAMEBUFFER,back.fbo);gl.enable(gl.SCISSOR_TEST);gl.scissor(x,y,tw,th);
          let query=null;
          if(this.timerExtension){query=gl.createQuery();gl.beginQuery(this.timerExtension.TIME_ELAPSED_EXT,query);}
          gl.drawArrays(gl.TRIANGLES,0,3);
          if(query)gl.endQuery(this.timerExtension.TIME_ELAPSED_EXT);
          pixels+=tw*th;this.present(pixels===total?back:this.front);
          try{
            await this.waitForGpu();
            if((!preview&&cancelled())||this.disposed||this.lost)return false;
            let measured=performance.now()-submitted;
            if(query&&gl.getQueryParameter(query,gl.QUERY_RESULT_AVAILABLE)&&!gl.getParameter(this.timerExtension.GPU_DISJOINT_EXT)){
              const time=gl.getQueryParameter(query,gl.QUERY_RESULT)/1e6;gpuMs+=time;measured=time;
            }else validTimer=false;
            // Retain recent expensive samples; grow at most 1.5x per fence and
            // shrink promptly when a tile crosses into a denser part of the grid.
            costPerPixel=Math.max(Math.max(.05,measured)/(tw*th),costPerPixel*.95);
            const desired=8/costPerPixel;
            budget=Math.max(256,Math.min(16384,Math.max(budget/2,Math.min(budget*1.5,desired))));
            // Preview timing must never enlarge expensive full-volume batches.
            if(preview)this.previewTilePixels=budget;else this.tilePixels=budget;
          }finally{if(query)gl.deleteQuery(query);}
          if(!cancelled()&&performance.now()-lastReport>200){lastReport=performance.now();this.onMetrics({...size,phase:preview?'preview':'refine',progress:pixels/total});}
          x+=tw;
        }
        y+=th;
      }
      const old=this.front;this.front=back;this.back=null;this.deleteTarget(old);
      this.gpuMs=validTimer?gpuMs:null;
      if(preview){const elapsed=performance.now()-start;this.previewPixels=Math.round(Math.max(3000,Math.min(16000,this.previewPixels*Math.min(1.5,50/Math.max(1,elapsed)))));}
      if(!this.firstDrawValidated){if(gl.getError()!==gl.NO_ERROR)throw new Error('分块渲染失败，请重新加载。');this.firstDrawValidated=true;}
      if(!cancelled())this.onMetrics({...size,gpuMs:this.gpuMs,timerAvailable:!!this.timerExtension,phase:preview?'preview-ready':'ready',progress:1});
      return true;
    }finally{
      gl.disable(gl.SCISSOR_TEST);gl.bindFramebuffer(gl.FRAMEBUFFER,null);
      if(this.back===back){this.deleteTarget(back);this.back=null;}
    }
  }
  async benchmark(){this.invalidate();return super.benchmark();}
  dispose(){
    this.invalidate();this.queue.dispose();this.deleteTarget(this.front);this.deleteTarget(this.back);this.front=this.back=null;
    super.dispose();
  }
}
