import {VolumeRenderer} from './renderer.js';
import {vertexShader,largeFragmentShader} from './large-shaders.js';
import {largePorosityRange} from './large-grid.js';

export class LargeVolumeRenderer extends VolumeRenderer {
  constructor(...args){super(...args);this.onMetrics=()=>{};this.quality='balanced';this.gpuMs=null;this.query=null;this.timerFrame=0;this.benchmarking=false;this.disposed=false;}
  async initialize(){
    const gl=this.canvas.getContext('webgl2',{alpha:false,antialias:false,depth:false,stencil:false,powerPreference:'high-performance'});
    if(!gl)throw new Error('当前浏览器未提供 WebGL 2，请启用硬件加速。');this.gl=gl;
    const max3d=gl.getParameter(gl.MAX_3D_TEXTURE_SIZE);
    if(this.volume.dims.some(n=>n>max3d))throw new Error('此设备的三维纹理尺寸不足，请选择较小的网格规模。');
    const compile=(kind,source)=>{const shader=gl.createShader(kind);gl.shaderSource(shader,source);gl.compileShader(shader);return shader;};
    const vs=compile(gl.VERTEX_SHADER,vertexShader),fs=compile(gl.FRAGMENT_SHADER,this.fragmentSource??largeFragmentShader);
    const program=gl.createProgram();gl.attachShader(program,vs);gl.attachShader(program,fs);gl.linkProgram(program);
    const parallel=gl.getExtension('KHR_parallel_shader_compile');
    if(parallel)while(!gl.getProgramParameter(program,parallel.COMPLETION_STATUS_KHR))await new Promise(requestAnimationFrame);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS)){console.error(gl.getShaderInfoLog(fs),gl.getProgramInfoLog(program));gl.deleteShader(vs);gl.deleteShader(fs);gl.deleteProgram(program);throw new Error('大规模体渲染着色器未能编译，请更新浏览器或选择原始演示。');}
    gl.deleteShader(vs);gl.deleteShader(fs);this.program=program;gl.useProgram(program);this.vao=gl.createVertexArray();gl.bindVertexArray(this.vao);
    const uploadStart=performance.now();
    const textures=this.textureSources?.(gl)??[['uAttributes',gl.TEXTURE_3D,this.volume.dims,this.volume.attributes,gl.RGBA8UI,gl.RGBA_INTEGER,gl.UNSIGNED_BYTE],['uBricks',gl.TEXTURE_3D,this.volume.coarse,this.volume.bricks,gl.RGBA8UI,gl.RGBA_INTEGER,gl.UNSIGNED_BYTE],['uAxes',gl.TEXTURE_2D,[this.volume.axisData.length/4,1],this.volume.axisData,gl.RGBA32F,gl.RGBA,gl.FLOAT],['uFold',gl.TEXTURE_2D,[this.volume.foldData.length/4,1],this.volume.foldData,gl.RGBA32F,gl.RGBA,gl.FLOAT]];
    gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);
    textures.forEach(([name,target,dims,data,internal,format,type],unit)=>{
      const limit=gl.getParameter(target===gl.TEXTURE_3D?gl.MAX_3D_TEXTURE_SIZE:gl.MAX_TEXTURE_SIZE);
      if(dims.some(n=>n>limit))throw new Error('此设备的纹理尺寸不足，请选择较小规模。');
      const t=gl.createTexture();this.textures.push(t);gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(target,t);
      gl.texParameteri(target,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(target,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
      gl.texParameteri(target,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(target,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      if(target===gl.TEXTURE_3D){gl.texParameteri(target,gl.TEXTURE_WRAP_R,gl.CLAMP_TO_EDGE);gl.texImage3D(target,0,internal,...dims,0,format,type,data);}
      else gl.texImage2D(target,0,internal,...dims,0,format,type,data);
      if(gl.getError()!==gl.NO_ERROR)throw new Error('显存分配失败，请选择 1M 或关闭其他使用显卡的页面。');
      gl.uniform1i(gl.getUniformLocation(program,name),unit);
    });
    const fence=gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0);gl.flush();
    try{
      let wait;
      while((wait=gl.clientWaitSync(fence,0,0))===gl.TIMEOUT_EXPIRED){
        if(gl.isContextLost()||performance.now()-uploadStart>15000)throw new Error('显卡数据上传未能完成，请选择较小规模重试。');
        await new Promise(requestAnimationFrame);
      }
      if(wait===gl.WAIT_FAILED)throw new Error('显卡数据上传失败，请选择较小规模重试。');
    }finally{gl.deleteSync(fence);}
    this.volume.stats.uploadMs=performance.now()-uploadStart;
    for(const key of ['attributes','bricks','axisData','foldData','vertices','nodes','ranges','columnPillars','kInterfaces'])this.volume[key]=null;
    const names=['uResolution','uEye','uRight','uUp','uForward','uBoundsMin','uBoundsMax','uTanFov','uDensity','uEdgeWidth','uPixelRatio','uClipPosition','uProperty','uEdges','uInterior','uClipAxis','uDimensions','uPorosityFilter','uPhi','uSkipBricks','uSplits','uNodeWidth','uNodeCount','uCellCount','uNoMatches','uSurfacePreview','uImported','uPropertyRange','uPropertyLog'];
    this.uniforms=Object.fromEntries(names.map(name=>[name,gl.getUniformLocation(program,name)]));
    gl.uniform3iv(this.uniforms.uDimensions,this.volume.dims);gl.uniform1i(this.uniforms.uSkipBricks,1);
    this.setGridUniforms?.();
    gl.uniform3fv(this.uniforms.uBoundsMin,this.volume.bounds.min);gl.uniform3fv(this.uniforms.uBoundsMax,this.volume.bounds.max);
    gl.disable(gl.DEPTH_TEST);gl.disable(gl.BLEND);gl.disable(gl.CULL_FACE);
    this.timerExtension=gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.resizeObserver=new ResizeObserver(()=>this.requestRender());this.resizeObserver.observe(this.canvas);
    this.events=new AbortController();this.bindInput(this.events.signal);
    this.canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();this.lost=true;this.onError(new Error('显卡上下文中断，请重新加载或选择更小规模。'));},{signal:this.events.signal});
    return this;
  }
  prepareFrame(pixelCap){
    if(!this.settings||this.lost||this.disposed)return;
    const {gl,uniforms:u,settings:s,canvas}=this,rect=canvas.getBoundingClientRect();if(rect.width<1||rect.height<1)return;
    const cap=pixelCap??(this.interacting&&!this.benchmarking?180000:({fast:240000,balanced:520000,detail:1200000}[this.quality]??520000));
    const resolution=Math.min(window.devicePixelRatio||1,2,Math.sqrt(cap/(rect.width*rect.height)));
    const width=Math.max(1,Math.round(rect.width*resolution)),height=Math.max(1,Math.round(rect.height*resolution));
    if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
    if(!this.modified)this.camera.distance=10.2/Math.min(1,rect.width/rect.height);
    gl.viewport(0,0,width,height);gl.useProgram(this.program);gl.bindVertexArray(this.vao);
    gl.uniform2f(u.uResolution,width,height);gl.uniform1f(u.uPixelRatio,width/rect.width);
    for(const [name,value]of Object.entries(this.basis()))gl.uniform3fv(u['u'+name[0].toUpperCase()+name.slice(1)],value);
    gl.uniform1f(u.uTanFov,Math.tan(21*Math.PI/180));gl.uniform1f(u.uDensity,28*(s.density/100)**2);
    gl.uniform1f(u.uEdgeWidth,s.lineWidth);gl.uniform1i(u.uProperty,s.property);gl.uniform1i(u.uEdges,s.edges?1:0);gl.uniform1i(u.uInterior,s.interior?1:0);
    gl.uniform1i(u.uPorosityFilter,s.porosityFilter?1:0);if(this.setPhi)this.setPhi(s);else gl.uniform2i(u.uPhi,...largePorosityRange(s.porosityMin,s.porosityMax));
    const axis=Math.max(0,s.clipAxis-1),{min,max}=this.volume.bounds;
    gl.uniform1i(u.uClipAxis,s.clipAxis);gl.uniform1f(u.uClipPosition,max[axis]-(max[axis]-min[axis])*s.clip/100);
    return {width,height};
  }
  draw(){
    const size=this.prepareFrame();if(!size)return;
    const {gl}=this,{width,height}=size;
    const timed=this.timerExtension&&!this.query;
    if(timed){this.query=gl.createQuery();gl.beginQuery(this.timerExtension.TIME_ELAPSED_EXT,this.query);}
    gl.drawArrays(gl.TRIANGLES,0,3);
    if(timed){gl.endQuery(this.timerExtension.TIME_ELAPSED_EXT);this.pollTimer();}
    if(!this.firstDrawValidated){const error=gl.getError();if(error!==gl.NO_ERROR)throw new Error('大规模渲染出现图形错误，请选择较小规模重试。');this.firstDrawValidated=true;}
    this.onMetrics({width,height,gpuMs:this.gpuMs,interacting:this.interacting&&!this.benchmarking,timerAvailable:!!this.timerExtension});
  }
  pollTimer(){
    if(!this.query||this.disposed||this.lost)return;
    const gl=this.gl;
    if(gl.getQueryParameter(this.query,gl.QUERY_RESULT_AVAILABLE)){
      if(!gl.getParameter(this.timerExtension.GPU_DISJOINT_EXT))this.gpuMs=gl.getQueryParameter(this.query,gl.QUERY_RESULT)/1e6;
      gl.deleteQuery(this.query);this.query=null;
      this.onMetrics({width:this.canvas.width,height:this.canvas.height,gpuMs:this.gpuMs,timerAvailable:true});
    }else this.timerFrame=requestAnimationFrame(()=>this.pollTimer());
  }
  setQuality(quality){this.quality=quality;this.requestRender();}
  requestRender(interacting=false){if(!this.benchmarking)super.requestRender(interacting);}
  async benchmark(){
    if(this.benchmarking)return null;this.benchmarking=true;this.interacting=false;clearTimeout(this.refineTimer);
    cancelAnimationFrame(this.frame);this.frame=0;
    const original=this.camera.azimuth;const times=[];let previous=null,start=null;
    try{
      while(!this.disposed&&!this.lost){
        const now=await new Promise(requestAnimationFrame);if(start===null)start=now;if(previous!==null)times.push(now-previous);previous=now;
        if(times.length>=12&&(now-start>=3000||times.length>=180))break;
        this.camera.azimuth=original+(now-start)*.00013;await this.draw();
        // Count completed GPU frames, not a growing queue of JS draw calls.
        const gl=this.gl,sync=gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0),submitted=performance.now();gl.flush();
        try{
          let status;
          while((status=gl.clientWaitSync(sync,0,0))===gl.TIMEOUT_EXPIRED){
            if(this.disposed||this.lost)return null;
            if(performance.now()-submitted>15000)throw new Error('单帧渲染耗时过长，请降低分辨率或网格规模。');
            await new Promise(resolve=>setTimeout(resolve,0));
          }
          if(status===gl.WAIT_FAILED)throw new Error('性能测试未能等待显卡完成，请重试。');
        }finally{gl.deleteSync(sync);}
      }
      if(this.disposed||this.lost)return null;
      // Exclude warm-up. RAF + GPU fences measure completed rotation cadence;
      // this includes display scheduling and polling overhead, not only GPU time.
      const measured=times.slice(1),elapsed=measured.reduce((a,b)=>a+b,0);
      return {fps:measured.length*1000/elapsed,frames:measured.length,elapsedMs:elapsed,width:this.canvas.width,height:this.canvas.height,scale:this.volume.scale,quality:this.quality};
    }finally{this.benchmarking=false;this.camera.azimuth=original;if(!this.disposed)this.requestRender();}
  }
  dispose(){this.disposed=true;cancelAnimationFrame(this.timerFrame);if(this.query&&this.gl)this.gl.deleteQuery(this.query);super.dispose();}
}
