// Exercise production initialization and resize presentation with a simulated
// compositor. This checks lifecycle gaps, not shader pixels or browser UI.
import assert from 'node:assert/strict';
import {VolumeRenderer} from './dist/renderer.js';
import {LargeVolumeRenderer} from './dist/large-renderer.js';
import {ExplicitVolumeRenderer} from './dist/explicit-renderer.js';

globalThis.window={devicePixelRatio:1};
const compilationWaits=[];
globalThis.requestAnimationFrame=callback=>{compilationWaits.push(callback);return compilationWaits.length;};
const volume={kind:'explicit',dims:[2,2,2],bounds:{min:[-1,-1,-1],max:[1,1,1]},stats:{cells:8,activeCells:8}};
function context(theme){
  let options,width=1,height=1,drawTarget=null,readTarget=null,color=[0,0,0,1],image=[0,0,0,1];
  const gl=new Proxy({
    FRAMEBUFFER:1,DRAW_FRAMEBUFFER:2,READ_FRAMEBUFFER:3,SCISSOR_TEST:4,COLOR_BUFFER_BIT:8,
    getParameter:()=>2048,getExtension:()=>({COMPLETION_STATUS_KHR:9}),getProgramParameter:()=>false,
    createShader:()=>({}),createProgram:()=>({}),
    bindFramebuffer(target,fbo){if(target===1||target===2)drawTarget=fbo;if(target===1||target===3)readTarget=fbo;},
    clearColor(...value){color=value;},clear(){assert.equal(drawTarget,null);image=[...color];},
    blitFramebuffer(){assert.equal(drawTarget,null);image=[...readTarget.image];}
  },{get:(target,key)=>key in target?target[key]:()=>{}});
  const canvas={ownerDocument:{documentElement:{dataset:{theme}}},
    getContext(_name,settings){options=settings;return gl;},getBoundingClientRect:()=>({width:240,height:160}),
    get width(){return width;},set width(value){width=value;image=[0,0,0,1];},
    get height(){return height;},set height(value){height=value;image=[0,0,0,1];}
  };
  return {canvas,gl,get image(){return image;},composite(){if(!options.preserveDrawingBuffer)image=[0,0,0,1];}};
}
const errors=[];
for(const Renderer of [VolumeRenderer,LargeVolumeRenderer,ExplicitVolumeRenderer]){
  for(const theme of ['light','dark']){
    const c=context(theme),renderer=new Renderer(c.canvas,volume,error=>errors.push(error)),waits=compilationWaits.length;
    // Hold shader compilation open, before settings or data uploads are ready.
    renderer.initialize().catch(error=>errors.push(error));await Promise.resolve();
    assert.equal(compilationWaits.length,waits+1,'Did not reach asynchronous compilation');
    assert.equal(renderer.settings,null);
    const expected=theme==='light'?[.93,.95,.97,1]:[.05,.08,.11,1];
    assert.deepEqual(c.image,expected,`${Renderer.name}: loading background used black`);
    for(let frame=0;frame<3;frame++){c.composite();assert.deepEqual(c.image,expected,'Compositor cleared the loading background');}
    if(Renderer===VolumeRenderer)continue;
    renderer.settings={lightMode:theme==='light',property:0,density:60,lineWidth:1.2,edges:true,interior:true,porosityFilter:false,porosityMin:8,porosityMax:32,clipAxis:0,clip:0};
    renderer.uniforms={};renderer.prepareFrame();
    assert.deepEqual(c.image,expected,'First resize exposed a black buffer before drawing');
    if(Renderer===ExplicitVolumeRenderer){
      const completed=[.28,.43,.56,1];renderer.front={width:240,height:160,fbo:{image:completed}};
      c.canvas.width=1;renderer.prepareFrame();assert.deepEqual(c.image,completed,'Resize discarded the completed frame');
      // Offscreen surface work spans multiple browser/compositor frames.
      for(let frame=0;frame<3;frame++){c.gl.bindFramebuffer(c.gl.FRAMEBUFFER,{});c.composite();assert.deepEqual(c.image,completed,'Processing cleared the completed frame');}
      renderer.front=null;renderer.present(null);assert.deepEqual(c.image,expected,'Empty presentation ignored the theme');
    }
  }
}
assert.deepEqual(errors,[]);
console.log('PASS loading backgrounds in all renderers: light/dark, before settings, compositor waits, first resize and retained frame during processing');
