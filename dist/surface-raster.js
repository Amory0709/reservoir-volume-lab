import {surfaceVertexShader,surfaceFragmentShader,surfaceBackgroundShader,surfaceTransparentFragmentShader,surfaceResolveShader} from './surface-shaders.js';
import {vertexShader} from './shaders.js';
export class SurfaceRaster{
  constructor(renderer){this.renderer=renderer;this.gl=renderer.gl;this.programs=[];this.buffers=[];this.key=null;this.batchFaces=32768;}
  async initialize(){
    const gl=this.gl;
    this.transparencySupported=!!gl.getExtension('EXT_color_buffer_float');
    const sources=[[surfaceVertexShader,surfaceFragmentShader],[vertexShader,surfaceBackgroundShader]];
    if(this.transparencySupported)sources.push([surfaceVertexShader,surfaceTransparentFragmentShader],[vertexShader,surfaceResolveShader]);
    for(const [vs,fs] of sources){
      const shaders=[];const program=gl.createProgram();this.programs.push(program);
      for(const [kind,source] of [[gl.VERTEX_SHADER,vs],[gl.FRAGMENT_SHADER,fs]]){const s=gl.createShader(kind);shaders.push(s);gl.shaderSource(s,source);gl.compileShader(s);gl.attachShader(program,s);}
      gl.linkProgram(program);const parallel=gl.getExtension('KHR_parallel_shader_compile');
      if(parallel)while(!gl.getProgramParameter(program,parallel.COMPLETION_STATUS_KHR)){if(this.renderer.disposed)throw new Error('Surface disposed');await new Promise(requestAnimationFrame);}
      const ok=gl.getProgramParameter(program,gl.LINK_STATUS);if(!ok)console.error(gl.getProgramInfoLog(program),...shaders.map(s=>gl.getShaderInfoLog(s)));
      shaders.forEach(s=>gl.deleteShader(s));if(!ok)throw new Error('表面渲染程序无法编译');
    }
    this.uniforms=this.programs.map(p=>Object.fromEntries([...Object.keys(this.renderer.uniforms),'uVertices','uAttributes','uColumnPillars','uKInterfaces','uPacked','uSurfaceOpacity','uSurfaceAccum','uSurfaceDepth'].map(n=>[n,gl.getUniformLocation(p,n)])));
    this.vao=gl.createVertexArray();this.buffer=gl.createBuffer();this.buffers.push(this.buffer);
    gl.bindVertexArray(this.vao);gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);gl.enableVertexAttribArray(0);gl.vertexAttribIPointer(0,1,gl.UNSIGNED_INT,4,0);gl.vertexAttribDivisor(0,1);
  }
  upload(data){
    const gl=this.gl,bytes=data.faces.byteLength+data.caps.byteLength;
    gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);gl.bufferData(gl.ARRAY_BUFFER,bytes,gl.STATIC_DRAW);
    if(data.faces.length)gl.bufferSubData(gl.ARRAY_BUFFER,0,data.faces);
    if(data.caps.length)gl.bufferSubData(gl.ARRAY_BUFFER,data.faces.byteLength,data.caps);
    if(gl.getError()!==gl.NO_ERROR)throw new Error('表面缓存显存分配失败');
    let offset=0;this.batches=[];
    for(let i=0;i<data.groups.length;i++){const count=data.groups[i];if(count)this.batches.push({offset,count,vertices:(i+1)*6,packed:1});offset+=count;}
    if(data.caps.length)this.batches.push({offset:data.faces.length,count:data.caps.length,vertices:6,packed:0});
    this.bytes=bytes;this.key=data.key;
  }
  bind(index,snapshot){
    const r=this.renderer,gl=this.gl,u=this.uniforms[index],s=snapshot.settings,v=r.volume;
    gl.useProgram(this.programs[index]);gl.bindVertexArray(index===0||index===2?this.vao:r.vao);
    for(const [name,value] of Object.entries(snapshot.basis))gl.uniform3fv(u['u'+name[0].toUpperCase()+name.slice(1)],value);
    gl.uniform2f(u.uResolution,this.width,this.height);gl.uniform1f(u.uPixelRatio,this.width/r.canvas.getBoundingClientRect().width);
    gl.uniform1f(u.uTanFov,Math.tan(21*Math.PI/180));gl.uniform1f(u.uDensity,28*(s.density/100)**2);
    gl.uniform1f(u.uEdgeWidth,s.lineWidth);gl.uniform1i(u.uProperty,s.property);gl.uniform1i(u.uEdges,s.edges?1:0);gl.uniform1i(u.uLightMode,s.lightMode?1:0);
    gl.uniform1f(u.uSurfaceOpacity,1-(s.surfaceTransparency??0)/100);
    gl.uniform1i(u.uPorosityFilter,s.porosityFilter?1:0);gl.uniform2f(u.uPhi,Math.fround(s.porosityMin/100),Math.fround(s.porosityMax/100));
    gl.uniform3iv(u.uDimensions,v.dims);gl.uniform3iv(u.uSplits,v.splitsX);gl.uniform1i(u.uImported,v.synthetic===false?1:0);
    gl.uniform3fv(u.uBoundsMin,v.bounds.min);gl.uniform3fv(u.uBoundsMax,v.bounds.max);
    gl.uniform1i(u.uClipAxis,s.clipAxis);const a=Math.max(0,s.clipAxis-1);gl.uniform1f(u.uClipPosition,v.bounds.max[a]-(v.bounds.max[a]-v.bounds.min[a])*s.clip/100);
    if(v.propertyInfo){const p=v.propertyInfo[s.property];gl.uniform2f(u.uPropertyRange,p.min,p.max);gl.uniform1i(u.uPropertyLog,p.log?1:0);}
    for(const [name,unit] of [['uVertices',0],['uAttributes',1],['uColumnPillars',4],['uKInterfaces',5]])gl.uniform1i(u[name],unit);
  }
  createTransparencyTarget(width,height){
    const gl=this.gl,target={fbo:gl.createFramebuffer(),textures:[]};
    try{
      gl.bindFramebuffer(gl.FRAMEBUFFER,target.fbo);
      for(const [index,internal,format] of [[0,gl.RGBA16F,gl.RGBA],[1,gl.R16F,gl.RED]]){
        const texture=gl.createTexture();target.textures.push(texture);
        gl.activeTexture(gl.TEXTURE6+index);gl.bindTexture(gl.TEXTURE_2D,texture);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D,0,internal,width,height,0,format,gl.HALF_FLOAT,null);
        gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0+index,gl.TEXTURE_2D,texture,0);
      }
      gl.drawBuffers([gl.COLOR_ATTACHMENT0,gl.COLOR_ATTACHMENT1]);
      const status=gl.checkFramebufferStatus(gl.FRAMEBUFFER),error=gl.getError();
      if(status!==gl.FRAMEBUFFER_COMPLETE||error!==gl.NO_ERROR)throw new Error('半透明表皮缓冲分配失败');
      gl.clearBufferfv(gl.COLOR,0,new Float32Array(4));gl.clearBufferfv(gl.COLOR,1,new Float32Array(4));
      return target;
    }catch(error){this.deleteTransparencyTarget(target);throw error;}
  }
  resolveTransparency(target,output,snapshot){
    const gl=this.gl;gl.disable(gl.BLEND);gl.bindFramebuffer(gl.FRAMEBUFFER,output.fbo);this.bind(3,snapshot);
    target.textures.forEach((texture,index)=>{gl.activeTexture(gl.TEXTURE6+index);gl.bindTexture(gl.TEXTURE_2D,texture);});
    gl.uniform1i(this.uniforms[3].uSurfaceAccum,6);gl.uniform1i(this.uniforms[3].uSurfaceDepth,7);gl.drawArrays(gl.TRIANGLES,0,3);
  }
  deleteTransparencyTarget(target){if(target){this.gl.deleteFramebuffer(target.fbo);target.textures.forEach(t=>this.gl.deleteTexture(t));}}
  dispose(){const gl=this.gl;this.programs.forEach(p=>gl.deleteProgram(p));this.buffers.forEach(b=>gl.deleteBuffer(b));if(this.vao)gl.deleteVertexArray(this.vao);}
}
