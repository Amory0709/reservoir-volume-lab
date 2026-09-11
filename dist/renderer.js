import {vertexShader,fragmentShader} from './shaders.js';
import {add,sub,scale,cross,normalize} from './mesh.js';
import {porosityBounds} from './filter.js';

export class VolumeRenderer {
  constructor(canvas,volume,onError) {
    this.canvas=canvas;this.volume=volume;this.onError=onError;this.settings=null;
    this.camera={azimuth:-.87,elevation:.52,distance:10.2,target:[0,0,-.05]};
    this.interacting=false;this.frame=0;this.refineTimer=0;this.textures=[];this.modified=false;
    this.onInteraction=()=>{};
  }
  async initialize() {
    const gl=this.canvas.getContext('webgl2',{alpha:false,antialias:false,depth:false,stencil:false,powerPreference:'high-performance'});
    if(!gl) throw new Error('当前浏览器未提供 WebGL 2。请启用硬件加速，或使用支持 WebGL 2 的浏览器打开。');
    this.gl=gl;
    const compile=(type,source)=>{const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);return s;};
    const vertex=compile(gl.VERTEX_SHADER,vertexShader),fragment=compile(gl.FRAGMENT_SHADER,fragmentShader);
    const program=gl.createProgram();gl.attachShader(program,vertex);gl.attachShader(program,fragment);gl.linkProgram(program);
    const parallel=gl.getExtension('KHR_parallel_shader_compile');
    if(parallel) while(!gl.getProgramParameter(program,parallel.COMPLETION_STATUS_KHR)) await new Promise(requestAnimationFrame);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS)) {
      console.error('Volume shader:',gl.getShaderInfoLog(vertex),gl.getShaderInfoLog(fragment),gl.getProgramInfoLog(program));
      throw new Error('当前设备未能编译体渲染着色器。请尝试更新浏览器，或在电脑上打开。');
    }
    gl.deleteShader(vertex);gl.deleteShader(fragment);this.program=program;gl.useProgram(program);
    this.vao=gl.createVertexArray();gl.bindVertexArray(this.vao);
    const maps=[['uTets','tetraTexture'],['uCells','cellTexture'],['uNodes','nodeTexture'],['uTriangles','triangleTexture']];
    maps.forEach(([uniform,key],unit)=>{
      const source=this.volume[key],texture=gl.createTexture();this.textures.push(texture);
      gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,texture);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,source.width,source.height,0,gl.RGBA,gl.FLOAT,source.data);
      gl.uniform1i(gl.getUniformLocation(program,uniform),unit);
    });
    this.uniforms=Object.fromEntries(['uResolution','uEye','uRight','uUp','uForward','uBoundsMin','uBoundsMax','uTanFov','uDensity','uEdgeWidth','uPixelRatio','uClipPosition','uProperty','uEdges','uInterior','uClipAxis','uNodeCount','uPorosityFilter','uPorosityRange'].map(k=>[k,gl.getUniformLocation(program,k)]));
    gl.disable(gl.DEPTH_TEST);gl.disable(gl.BLEND);gl.disable(gl.CULL_FACE);
    gl.uniform3fv(this.uniforms.uBoundsMin,this.volume.bounds.min);gl.uniform3fv(this.uniforms.uBoundsMax,this.volume.bounds.max);
    gl.uniform1i(this.uniforms.uNodeCount,this.volume.stats.bvhNodes);
    this.resizeObserver=new ResizeObserver(()=>this.requestRender());this.resizeObserver.observe(this.canvas);
    this.events=new AbortController();this.bindInput(this.events.signal);
    this.canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();this.lost=true;this.onError(new Error('图形上下文中断。请点击“重新加载”恢复三维视图。'));},{signal:this.events.signal});
    return this;
  }
  basis() {
    const c=this.camera,cos=Math.cos(c.elevation);
    const offset=[cos*Math.cos(c.azimuth),cos*Math.sin(c.azimuth),Math.sin(c.elevation)];
    const eye=add(c.target,scale(offset,c.distance)),forward=normalize(sub(c.target,eye));
    const right=normalize(cross(forward,[0,0,1])),up=normalize(cross(right,forward));
    return {eye,forward,right,up};
  }
  draw() {
    if(!this.settings || this.lost) return;
    const {gl,uniforms:u,settings:s,canvas}=this;
    const rect=canvas.getBoundingClientRect();if(rect.width<1 || rect.height<1) return;
    const cap=this.interacting?360000:850000;
    const resolutionScale=Math.min(window.devicePixelRatio||1,1.4,Math.sqrt(cap/(rect.width*rect.height)))*(this.interacting?.8:1);
    const width=Math.max(1,Math.round(rect.width*resolutionScale)),height=Math.max(1,Math.round(rect.height*resolutionScale));
    if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
    if(!this.modified) this.camera.distance=10.2/Math.min(1,rect.width/rect.height);
    const basis=this.basis();
    gl.viewport(0,0,width,height);gl.useProgram(this.program);gl.bindVertexArray(this.vao);
    gl.uniform2f(u.uResolution,width,height);gl.uniform1f(u.uPixelRatio,width/rect.width);
    for(const [key,value] of Object.entries(basis)) gl.uniform3fv(u['u'+key[0].toUpperCase()+key.slice(1)],value);
    gl.uniform1f(u.uTanFov,Math.tan(21*Math.PI/180));
    gl.uniform1f(u.uDensity,28*Math.pow(s.density/100,2));
    gl.uniform1f(u.uEdgeWidth,s.lineWidth);gl.uniform1i(u.uProperty,s.property);
    gl.uniform1i(u.uPorosityFilter,s.porosityFilter?1:0);
    gl.uniform2f(u.uPorosityRange,...porosityBounds(s.porosityMin??8,s.porosityMax??32));
    gl.uniform1i(u.uEdges,s.edges?1:0);gl.uniform1i(u.uInterior,s.interior?1:0);
    gl.uniform1i(u.uClipAxis,s.clipAxis);
    const axis=Math.max(0,s.clipAxis-1),{min,max}=this.volume.bounds;
    gl.uniform1f(u.uClipPosition,max[axis]-(max[axis]-min[axis])*s.clip/100);
    gl.drawArrays(gl.TRIANGLES,0,3);
    const error=gl.getError();if(error!==gl.NO_ERROR) throw new Error('三维渲染出现图形错误，请重新加载。');
  }
  requestRender(interacting=false) {
    if(interacting) {
      this.interacting=true;clearTimeout(this.refineTimer);
      this.refineTimer=setTimeout(()=>{this.interacting=false;this.requestRender();},150);
    }
    if(!this.frame) this.frame=requestAnimationFrame(()=>{this.frame=0;try{this.draw();}catch(e){this.onError(e);}});
  }
  setSettings(settings,interacting=false) {this.settings={...settings};this.requestRender(interacting);}
  endInteraction() {this.requestRender();}
  setView(view) {
    const views={iso:[-.87,.52],top:[-Math.PI/2,Math.PI/2-.001],front:[-Math.PI/2,.035]};
    [this.camera.azimuth,this.camera.elevation]=views[view]??views.iso;
    this.requestRender();
  }
  reset() {this.modified=false;this.camera.target=[0,0,-.05];this.setView('iso');}
  rotate(dx,dy) {
    this.modified=true;this.camera.azimuth-=dx*.007;
    this.camera.elevation=Math.max(-1.45,Math.min(1.55,this.camera.elevation+dy*.006));
    this.onInteraction();this.requestRender(true);
  }
  zoom(factor) {this.modified=true;this.camera.distance=Math.max((this.volume.kind==='large'||this.volume.kind==='explicit') ? .12 : 4.3,Math.min(45,this.camera.distance*factor));this.requestRender(true);}
  pan(dx,dy) {
    this.modified=true;const {right,up}=this.basis();
    const p=2*this.camera.distance*Math.tan(21*Math.PI/180)/this.canvas.getBoundingClientRect().height;
    this.camera.target=add(this.camera.target,add(scale(right,-dx*p),scale(up,dy*p)));this.requestRender(true);
  }
  bindInput(signal) {
    const c=this.canvas,pointers=new Map();
    const touchGeometry=()=>{
      const p=[...pointers.values()];if(p.length<2)return null;
      return {x:(p[0].x+p[1].x)/2,y:(p[0].y+p[1].y)/2,d:Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y)};
    };
    c.addEventListener('pointerdown',e=>{c.focus({preventScroll:true});c.setPointerCapture(e.pointerId);pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});},{signal});
    c.addEventListener('pointermove',e=>{
      const before=pointers.get(e.pointerId);if(!before)return;
      const oldTouch=touchGeometry();pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});const nowTouch=touchGeometry();
      if(nowTouch&&oldTouch){this.zoom(oldTouch.d/Math.max(2,nowTouch.d));this.pan(nowTouch.x-oldTouch.x,nowTouch.y-oldTouch.y);}
      else if(e.shiftKey || (e.buttons&2)) this.pan(e.clientX-before.x,e.clientY-before.y);
      else this.rotate(e.clientX-before.x,e.clientY-before.y);
    },{signal});
    const release=e=>{pointers.delete(e.pointerId);if(c.hasPointerCapture(e.pointerId))c.releasePointerCapture(e.pointerId);if(!pointers.size)this.endInteraction();};
    c.addEventListener('pointerup',release,{signal});c.addEventListener('pointercancel',release,{signal});c.addEventListener('lostpointercapture',e=>pointers.delete(e.pointerId),{signal});
    c.addEventListener('contextmenu',e=>e.preventDefault(),{signal});
    c.addEventListener('wheel',e=>{e.preventDefault();const d=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?300:1);this.zoom(Math.exp(Math.max(-.25,Math.min(.25,d*.001))));},{passive:false,signal});
    c.addEventListener('keydown',e=>{
      const keys=['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-','r','R','Home'];if(!keys.includes(e.key))return;e.preventDefault();
      if(e.key==='ArrowLeft')this.rotate(-10,0);if(e.key==='ArrowRight')this.rotate(10,0);
      if(e.key==='ArrowUp')this.rotate(0,10);if(e.key==='ArrowDown')this.rotate(0,-10);
      if(e.key==='+'||e.key==='=')this.zoom(.92);if(e.key==='-')this.zoom(1.08);
      if(['r','R','Home'].includes(e.key))this.reset();
    },{signal});
  }
  dispose() {
    cancelAnimationFrame(this.frame);clearTimeout(this.refineTimer);this.resizeObserver?.disconnect();this.events?.abort();
    if(this.gl){this.textures.forEach(t=>this.gl.deleteTexture(t));this.gl.deleteProgram(this.program);this.gl.deleteVertexArray(this.vao);}
  }
}
