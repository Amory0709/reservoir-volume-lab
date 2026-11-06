import {VolumeRenderer} from './renderer.js';
import {ExplicitVolumeRenderer} from './explicit-renderer.js';
import {surfaceKey,surfaceFilterKey} from './surface-cache.js';

const caps={fast:240000,balanced:520000,detail:1200000};
export function comparisonRect(rect,canvasRect,width,height){
  const x=Math.round((rect.left-canvasRect.left)*width/canvasRect.width),y=Math.round((rect.top-canvasRect.top)*height/canvasRect.height);
  const right=Math.round((rect.right-canvasRect.left)*width/canvasRect.width),bottom=Math.round((rect.bottom-canvasRect.top)*height/canvasRect.height);
  return {x:Math.max(0,x),y:Math.max(0,y),width:Math.max(0,Math.min(width,right)-Math.max(0,x)),height:Math.max(0,Math.min(height,bottom)-Math.max(0,y))};
}
class PaneCamera extends VolumeRenderer{
  constructor(session,view){super(view.element,session.volume,session.onError);this.session=session;this.view=view;this.events=new AbortController();this.bindInput(this.events.signal);}
  requestRender(interacting=false){this.session.cameraChanged(this.view,interacting);}
  endInteraction(){this.session.endInteraction(this.view);}
}

// One geometry upload, one device/context and one asynchronous GPU producer.
// Each pane owns only its settings, surface index and retained image.
export class ComparisonRenderer{
  constructor(canvas,volume,views,{backend='webgl',onMetrics=()=>{},onError=()=>{}}={}){
    this.canvas=canvas;this.volume=volume;this.views=views;this.backend=backend;this.onMetrics=onMetrics;this.onError=onError;
    this.linked=true;this.epoch=0;this.active=null;this.closed=false;this.ready=false;this.scheduled=0;this.work=null;
    for(const view of views)Object.assign(view,{revision:0,front:null,displayTarget:null,frontViewStamp:null,surfacePending:null,surfaceRequestedKey:null,needSurface:true,needVolume:view.id==='volume',interacting:false,quality:view.quality??'detail',renderWidth:0,renderHeight:0});
  }
  async initialize(){
    let Renderer=ExplicitVolumeRenderer;
    if(this.backend==='webgpu')({WebGPUVolumeRenderer:Renderer}=await import('./webgpu-renderer.js'));
    this.renderer=new Renderer(this.canvas,this.volume,error=>this.fail(error));
    await this.renderer.initialize();const r=this.renderer;
    r.events?.abort();r.resizeObserver?.disconnect();r.invalidate();
    if(r.surfaceDisabled||!r.surface||!r.surfacePending)throw new Error('表皮缓存未能初始化，无法进行左右对比。请降低网格规模重试。');
    const initial=r.surfacePending,second=await r.createSurfaceCache();
    this.views[0].surface=r.surface;this.views[1].surface=second;
    for(const view of this.views){view.surfacePending=initial;view.surfaceRequestedKey=initial.key;view.controller=new PaneCamera(this,view);}
    this.worker=r.surfaceWorker;
    this.worker.onmessage=({data})=>{
      if(this.closed)return;
      const view=this.views.find(v=>v.id===data.lane);
      if(data.type==='error'){this.fail(new Error(data.message),view);return;}
      if(data.type!=='surface'||!view||view.surfaceRequestedKey!==data.key)return;
      view.surfacePending=data;view.surfaceCpuBytes=data.cpuBytes;view.needSurface=true;
      if(this.active===view)r.surfacePending=data;
      this.epoch++;this.wake();
    };
    this.worker.onerror=()=>this.fail(new Error('共享表皮缓存线程已中断，请重新加载。'));
    this.worker.postMessage({type:'compare'});
    // Canvas dimensions below describe the active pane. The real canvas is
    // sized only by the compositor; grid rendering always uses offscreen targets.
    const session=this;
    r.canvas={ownerDocument:this.canvas.ownerDocument,getBoundingClientRect:()=>session.active.element.getBoundingClientRect(),
      get width(){return session.active.renderWidth;},set width(v){session.active.renderWidth=v;},
      get height(){return session.active.renderHeight;},set height(v){session.active.renderHeight=v;}};
    r.present=target=>{if(this.closed)return;this.active.displayTarget=target;this.composite();};
    const surfaceStamp=r.surfaceViewStamp.bind(r);r.surfaceViewStamp=()=>surfaceStamp()+'|'+r.quality;
    r.clearBackground=()=>this.composite();
    r.ensureSurface=()=>{if(this.active)this.ensureSurface(this.active);};
    r.requestRender=()=>{if(this.ready&&!this.closed&&this.active)this.invalidate(this.active);};
    r.onMetrics=values=>{if(!this.closed&&this.active)this.onMetrics(this.active,values);};
    r.disableSurface=reason=>this.fail(new Error(reason),this.active);
    this.events=new AbortController();
    this.canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();r.lost=true;this.fail(new Error('显卡上下文已中断，请重新加载或选择较小网格。'));},{signal:this.events.signal});
    this.resizeObserver=new ResizeObserver(()=>this.resize());
    this.resizeObserver.observe(this.canvas);for(const v of this.views)this.resizeObserver.observe(v.element);
    this.ready=true;this.resize();return this;
  }
  fail(error,view){
    if(this.closed)return;
    if(view){view.failed=true;view.needSurface=false;view.needVolume=false;}else{for(const v of this.views){v.failed=true;v.needSurface=false;v.needVolume=false;}}
    this.epoch++;this.onError(error,view);
  }
  getImportLimits(){const r=this.renderer;return r.getImportLimits?.()??{max3d:r.gl.getParameter(r.gl.MAX_3D_TEXTURE_SIZE),max2d:r.gl.getParameter(r.gl.MAX_TEXTURE_SIZE)};}
  setLinked(linked){this.linked=linked;if(linked)this.cameraChanged(this.views[0],false);}
  cameraChanged(view,interacting){
    if(!this.ready||this.closed)return;
    if(!view.controller.modified){const rect=view.element.getBoundingClientRect();view.controller.camera.distance=10.2/Math.min(1,rect.width/Math.max(1,rect.height));}
    const targets=this.linked?this.views:[view];
    for(const target of targets){
      if(target!==view){target.controller.camera=structuredClone(view.controller.camera);target.controller.modified=view.controller.modified;}
      target.interacting=interacting;clearTimeout(target.quietTimer);this.invalidate(target);
      if(interacting)target.quietTimer=setTimeout(()=>{target.interacting=false;this.wake();},80);
    }
  }
  endInteraction(view){for(const target of this.linked?this.views:[view]){clearTimeout(target.quietTimer);target.interacting=false;}this.wake();}
  setSettings(view,patch){
    if(Object.entries(patch).every(([key,value])=>view.settings[key]===value))return;
    if(view.id==='volume'&&['density','porosityFilter','porosityMin','porosityMax','edges'].some(key=>key in patch&&patch[key]!==view.settings[key]))this.renderer.tilePixels=Math.min(this.renderer.tilePixels,1024);
    view.settings={...view.settings,...patch,surfaceOnly:view.id==='surface',progressive:false};view.failed=false;
    if(this.active===view)this.renderer.settings=view.settings;
    this.invalidate(view);
  }
  setQuality(view,value){if(view.quality===value)return;view.quality=value;this.invalidate(view);}
  invalidate(view){
    if(!this.ready||this.closed)return;
    view.revision++;this.epoch++;view.needSurface=true;view.needVolume=view.id==='volume';
    this.ensureSurface(view);this.onMetrics(view,{phase:'pending'});this.wake();
  }
  ensureSurface(view){
    if(!view.settings||view.failed)return;
    const key=surfaceKey(view.settings,this.volume);if(key===view.surfaceRequestedKey)return;
    view.surfaceRequestedKey=key;view.surfacePending=null;
    if(this.active===view){this.renderer.surfaceRequestedKey=key;this.renderer.surfacePending=null;}
    const s=view.settings,a=Math.max(0,s.clipAxis-1),v=this.volume;
    this.worker.postMessage({type:'build',lane:view.id,key,filterKey:surfaceFilterKey(s,v),axis:s.clipAxis,position:Math.fround(v.bounds.max[a]-(v.bounds.max[a]-v.bounds.min[a])*s.clip/100)});
    this.onMetrics(view,{phase:'surface-pending'});
  }
  resize(){
    if(!this.ready||this.closed)return;
    const canvasRect=this.canvas.getBoundingClientRect(),viewRects=this.views.map(view=>view.element.getBoundingClientRect());
    const sizeKey=JSON.stringify([canvasRect.width,canvasRect.height,window.devicePixelRatio||1,...viewRects.flatMap(rect=>[rect.width,rect.height,rect.left-canvasRect.left,rect.top-canvasRect.top])]);
    if(sizeKey===this.sizeKey)return;this.sizeKey=sizeKey;
    for(const view of this.views){const rect=view.element.getBoundingClientRect();if(!view.controller.modified)view.controller.camera.distance=10.2/Math.min(1,rect.width/Math.max(1,rect.height));this.invalidate(view);}
    if(this.linked){const source=this.views[0].controller;this.views[1].controller.camera=structuredClone(source.camera);this.views[1].controller.modified=source.modified;}
    // Compositing touches no shader uniforms or offscreen image contents.
    this.composite();
  }
  wake(){if(this.closed||!this.ready||this.work||this.scheduled)return;this.scheduled=requestAnimationFrame(()=>{this.scheduled=0;this.work=this.pump().finally(()=>{this.work=null;if(this.nextJob())this.wake();});});}
  nextJob(){
    const eligible=view=>!view.failed&&view.settings&&(view.surfacePending?.key===surfaceKey(view.settings,this.volume)||view.surface.key===surfaceKey(view.settings,this.volume));
    // Every pending shell is drawn before any long volume job. A right-side
    // change cancels the left volume at its next GPU boundary and takes priority.
    const preview=this.views.find(view=>view.needSurface&&eligible(view));
    if(preview)return {view:preview,preview:true};
    const volume=this.views.find(view=>view.needVolume&&!view.interacting&&eligible(view));
    return volume?{view:volume,preview:false}:null;
  }
  async pump(){
    while(!this.closed){
      const job=this.nextJob();if(!job)return;
      const {view,preview}=job,r=this.renderer,epoch=this.epoch,revision=view.revision,start=performance.now();
      this.active=view;
      Object.assign(r,{settings:view.settings,camera:view.controller.camera,modified:true,quality:view.quality,displayPixelCap:view.id==='volume'?caps.detail:caps[view.quality],front:view.front,back:null,frontViewStamp:view.frontViewStamp,surface:view.surface,surfacePending:view.surfacePending,surfaceRequestedKey:view.surfaceRequestedKey,surfaceDisabled:false});
      let done=false;
      try{done=await r.renderFrame({preview},()=>this.closed||epoch!==this.epoch);}
      catch(error){if(!this.closed)this.fail(error,view);}
      finally{Object.assign(view,{front:r.front,frontViewStamp:r.frontViewStamp,surfacePending:r.surfacePending});this.active=null;}
      if(this.closed)return;
      if(done&&revision===view.revision){
        if(preview)view.needSurface=false;else{view.needVolume=false;this.onMetrics(view,{completedMs:performance.now()-start});}
      }else if(!done&&epoch===this.epoch&&!view.failed){
        // Missing caches wait for their worker message, never spin the GPU.
        return;
      }
    }
  }
  composite(){
    if(this.closed||!this.renderer||this.renderer.lost)return;
    const r=this.renderer,canvas=this.canvas,rect=canvas.getBoundingClientRect();if(rect.width<1||rect.height<1)return;
    const limit=r.device?.limits.maxTextureDimension2D??r.gl.getParameter(r.gl.MAX_TEXTURE_SIZE);
    const scale=Math.min(window.devicePixelRatio||1,2,Math.sqrt(4000000/(rect.width*rect.height)),limit/Math.max(rect.width,rect.height));
    const width=Math.max(1,Math.round(rect.width*scale)),height=Math.max(1,Math.round(rect.height*scale));
    if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
    const light=this.views[0].settings.lightMode,bg=light?[.93,.95,.97,1]:[.05,.08,.11,1];
    if(r.gl){
      const gl=r.gl;gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.disable(gl.SCISSOR_TEST);gl.clearColor(...bg);gl.clear(gl.COLOR_BUFFER_BIT);
      for(const view of this.views){
        const target=view.displayTarget;if(!target)continue;
        const area=comparisonRect(view.element.getBoundingClientRect(),rect,width,height);if(!area.width||!area.height)continue;
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER,target.fbo);gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,null);
        gl.blitFramebuffer(0,0,target.width,target.height,area.x,height-area.y-area.height,area.x+area.width,height-area.y,gl.COLOR_BUFFER_BIT,gl.LINEAR);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    }else{
      const encoder=r.device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[{view:r.context.getCurrentTexture().createView(),loadOp:'clear',storeOp:'store',clearValue:bg}]});
      pass.setPipeline(r.presentation);
      for(const view of this.views){
        const target=view.displayTarget;if(!target)continue;
        const area=comparisonRect(view.element.getBoundingClientRect(),rect,width,height);if(!area.width||!area.height)continue;
        target.presentGroup??=r.device.createBindGroup({layout:r.presentLayout,entries:[{binding:0,resource:target.texture.createView()},{binding:1,resource:r.sampler}]});
        pass.setViewport(area.x,area.y,area.width,area.height,0,1);pass.setScissorRect(area.x,area.y,area.width,area.height);pass.setBindGroup(0,target.presentGroup);pass.draw(3);
      }
      pass.end();r.device.queue.submit([encoder.finish()]);
    }
  }
  async dispose(){
    if(this.closed)return;this.closed=true;this.epoch++;cancelAnimationFrame(this.scheduled);this.resizeObserver?.disconnect();this.events?.abort();
    for(const view of this.views){clearTimeout(view.quietTimer);view.controller?.events?.abort();}
    if(!this.renderer)return;
    this.renderer.disposed=true;await this.work;
    for(const view of this.views){if(view.surface&&view.surface!==this.renderer.surface)view.surface.dispose();if(view.front&&view.front!==this.renderer.front)this.renderer.deleteTarget(view.front);view.displayTarget=null;}
    this.renderer.dispose();
  }
}
