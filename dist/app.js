import {createSyntheticGrid,buildVolumeData} from './mesh.js';
import {VolumeRenderer} from './renderer.js';
import {LargeVolumeRenderer} from './large-renderer.js';
import {ExplicitVolumeRenderer} from './explicit-renderer.js';
import {EXPLICIT_SCALES,countExplicitMatches} from './explicit-grid.js';
import {LARGE_SCALES,countLargeMatches} from './large-grid.js';
import {porosityBounds,countPorosityMatches} from './filter.js';

const $=id=>document.getElementById(id);
const parameters=new URLSearchParams(location.search),webgpuRequested=parameters.get('backend')==='webgpu';
let GPUExplicitRenderer;
const state={blockTraversal:parameters.get('blocks')==='1',lightMode:document.documentElement.dataset.theme==='light',progressive:false,property:0,density:60,edges:true,lineWidth:1.2,interior:true,surfaceTransparency:0,surfaceOnly:false,clipAxis:0,clip:0,porosityFilter:true,porosityMin:8,porosityMax:32};
const presets={solid:{density:60,edges:true,interior:true,surfaceOnly:false,clipAxis:0,clip:0},volume:{density:15,edges:true,interior:true,surfaceOnly:false,clipAxis:0,clip:0},cut:{density:76,edges:true,interior:true,surfaceOnly:false,clipAxis:1,clip:38}};
const properties=[
  {name:'含油饱和度',unit:'So · 无量纲',ticks:['0.05','0.25','0.45','0.65','0.85'],note:'单元内保持常值，保留属性突变。'},
  {name:'孔隙度',unit:'φ · %',ticks:['8','14','20','26','32'],note:'各单元独立着色，无跨单元平滑。'},
  {name:'渗透率',unit:'K · mD · 对数',ticks:['0.5','3.7','27','203','1,500'],note:'对数色标显示合成高渗通道。'}
];
let renderer,volume,filterCacheKey='',matchedCells=0,worker,loadToken=0,currentScale='explicit-10m',isLoading=false,controlsDisabled=false;
const controlSelector='.panel input,.panel select,.panel button,.view-tools button,#empty-filter-reset,#theme-toggle';
document.addEventListener('reservoir-theme-change',event=>{
  if(state.lightMode===event.detail.lightMode)return;
  state.lightMode=event.detail.lightMode;
  if(renderer?.settings&&!isLoading&&!renderer.benchmarking)renderer.setSettings(state);
});
const phiLimits=()=>volume?.synthetic===false?[0,100]:[8,32];
function propertyDisplay(slot){
  const p=volume?.propertyInfo?.[slot];if(!p)return properties[slot];
  if(!p.available)return {name:'网格几何',unit:'未加载此属性',ticks:['—','—','—','—','—'],note:'灰色显示真实几何；可在导入区选择属性后重新加载。'};
  const factor=slot===1?100:1,ticks=Array.from({length:5},(_,i)=>{const n=(p.log?Math.exp(Math.log(p.min)+(Math.log(p.max)-Math.log(p.min))*i/4):p.min+(p.max-p.min)*i/4)*factor;return Number(n.toPrecision(4)).toLocaleString(undefined,{maximumSignificantDigits:4});});
  return {name:p.title,unit:p.unit+(p.log?' · 对数':''),ticks,note:p.missing?'缺失属性的活动单元显示为灰色。':'文件原始属性；色标按活动单元的有效值范围显示。'};
}
function reportError(error){$('status').hidden=true;$('volume-progress').hidden=true;$('error-text').textContent=error.message||'请重新加载后重试。';$('error').hidden=false;}
$('retry').addEventListener('click',()=>location.reload());
function syncUI() {
  const [phiLow,phiHigh]=phiLimits(),hasPhi=volume?.propertyInfo?volume.propertyInfo[1].available:true;
  $('porosity-filter').disabled=!hasPhi;
  for(const key of ['min','max'])for(const suffix of ['','-slider']){const e=$('porosity-'+key+suffix);e.min=phiLow;e.max=phiHigh;}
  $('porosity-filter').checked=state.porosityFilter;
  for(const [key,value] of [['min',state.porosityMin],['max',state.porosityMax]]) {
    $('porosity-'+key).value=String(Number(value.toFixed(3)));$('porosity-'+key).disabled=!state.porosityFilter||!hasPhi;
    $('porosity-'+key+'-slider').value=value;$('porosity-'+key+'-slider').disabled=!state.porosityFilter||!hasPhi;
  }
  $('porosity-min').max=state.porosityMax;$('porosity-max').min=state.porosityMin;
  $('porosity-min-slider').setAttribute('aria-valuetext',state.porosityMin+'%');$('porosity-max-slider').setAttribute('aria-valuetext',state.porosityMax+'%');
  if(volume) {
    const key=[currentScale,state.porosityFilter,state.porosityMin,state.porosityMax].join(':');
    if(key!==filterCacheKey){matchedCells=volume.kind==='explicit'?countExplicitMatches(volume,state):volume.kind==='large'?countLargeMatches(volume,state):countPorosityMatches(volume.grid.properties,state);filterCacheKey=key;}
    const count=matchedCells.toLocaleString(),total=(volume.stats.activeCells??volume.stats.cells).toLocaleString();
    $('filter-count').textContent=state.porosityFilter?count+' / '+total+' 格':'全部 '+total+' 格';
    $('cell-count').textContent=(matchedCells===(volume.stats.activeCells??volume.stats.cells)?total:count+' / '+total)+(volume.kind==='explicit'?' 个活动单元':' 个单元');
    $('empty-filter').hidden=matchedCells!==0;
  }
  $('property').value=String(state.property);$('density').value=state.density;$('density-value').textContent=state.density===100?'100% · 不透明':state.density+'%';
  const surfaceAvailable=!!renderer?.surface&&!renderer.surfaceDisabled;
  $('block-controls').hidden=volume?.kind!=='explicit'||webgpuRequested;$('block-traversal').checked=state.blockTraversal;
  $('surface-controls').hidden=volume?.kind!=='explicit';
  $('surface-transparency').value=state.surfaceTransparency;$('surface-transparency-value').textContent=state.surfaceTransparency+'%';
  $('surface-transparency').disabled=!surfaceAvailable||!renderer.surface.transparencySupported;
  $('surface-only').checked=state.surfaceOnly;$('surface-only').disabled=!surfaceAvailable;
  $('progressive-controls').hidden=volume?.kind!=='explicit'||webgpuRequested;$('progressive-volume').checked=state.progressive;$('progressive-volume').disabled=state.surfaceOnly||state.density>=100||webgpuRequested;
  $('surface-hint').textContent=!surfaceAvailable?'表皮缓存当前不可用。':!renderer.surface.transparencySupported?'当前设备不支持半透明表皮，可以继续显示不透明表皮。':'调节时自动停留在表皮。透明度不影响网格线开关；取消“仅显示表皮”且体密度低于 100% 时，静止显示内部体积。';
  $('edges').checked=state.edges;$('interior').checked=state.interior;$('interior').disabled=!state.edges;
  $('line-width').value=state.lineWidth;$('line-width').disabled=!state.edges;$('line-width-value').textContent=state.lineWidth.toFixed(1)+' px';
  $('clip-axis').value=String(state.clipAxis);$('clip').value=state.clip;$('clip').disabled=state.clipAxis===0;$('clip-value').textContent=state.clip+'%';
  $('clip-badge').textContent=state.clipAxis>0?'XYZ'[state.clipAxis-1]+' 方向剖切':'完整体积';
  const p=propertyDisplay(state.property);$('legend-name').textContent=p.name;$('legend-unit').textContent=p.unit;$('property-note').textContent=p.note;
  const anyProperty=volume?.propertyInfo?.some(p=>p.available);
  Array.from($('property').options).forEach((option,i)=>{const info=volume?.propertyInfo?.[i];option.disabled=!!info&&!info.available&&(anyProperty||i!==0);option.textContent=info?(info.available?info.title+(info.unit?' · '+info.unit:''):i===0&&!anyProperty?'网格几何 · 无属性':info.name+' · 未加载'):['含油饱和度 · So','孔隙度 · φ','渗透率 · K'][i];});
  $('filter-reset').disabled=!hasPhi;
  $('legend-ticks').replaceChildren(...p.ticks.map(t=>{const e=document.createElement('span');e.textContent=t;return e;}));
  document.querySelectorAll('[data-preset]').forEach(b=>{const active=Object.entries(presets[b.dataset.preset]).every(([k,v])=>state[k]===v);b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
  // Loading calls syncUI too; it must not re-enable dependent controls early.
  if(controlsDisabled)document.querySelectorAll(controlSelector).forEach(e=>e.disabled=true);
}
function applySettings(patch,interacting=false) {
  if(!patch||typeof patch!=='object'||Array.isArray(patch))throw new Error('设置必须为对象。');
  if(isLoading&&Object.keys(patch).length)throw new Error('请等待网格加载完成。');
  const ranges={property:[0,2,true],density:[0,100,false],surfaceTransparency:[0,100,false],lineWidth:[.5,2.5,false],clipAxis:[0,3,true],clip:[0,90,false],porosityMin:[...phiLimits(),false],porosityMax:[...phiLimits(),false]};
  for(const [k,v] of Object.entries(patch)) {
    if(!(k in state))throw new Error('未知设置：'+k);
    if(k in ranges){const [a,b,int]=ranges[k];if(typeof v!=='number'||!Number.isFinite(v)||v<a||v>b||(int&&!Number.isInteger(v)))throw new Error(k+' 超出有效范围。');}
    else if(typeof v!=='boolean')throw new Error(k+' 必须为布尔值。');
  }
  const lo=patch.porosityMin??state.porosityMin,hi=patch.porosityMax??state.porosityMax;
  if(lo>hi)throw new Error('孔隙度下限不能大于上限。');
  if(volume?.synthetic!==false)porosityBounds(lo,hi);
  if(patch.porosityFilter&&volume?.propertyInfo&&!volume.propertyInfo[1].available)throw new Error('请先加载有效孔隙度属性。');
  if(patch.property!==undefined&&volume?.propertyInfo&&!volume.propertyInfo[patch.property].available)throw new Error('该属性尚未加载。');
  if(patch.surfaceTransparency>0&&(!renderer?.surface?.transparencySupported||renderer.surfaceDisabled))throw new Error('当前设备或模型不支持半透明表皮。');
  if(patch.surfaceOnly&&(!renderer?.surface||renderer.surfaceDisabled))throw new Error('当前模型的表皮缓存不可用。');
  if(patch.progressive&&webgpuRequested)throw new Error('WebGPU 实验版在计算完成后整幅显示体积。');
  if(renderer?.benchmarking)throw new Error('请等待性能测试完成后再修改设置。');
  if(Object.keys(patch).length)$('benchmark-result').textContent='尚未测试当前设置';
  Object.assign(state,patch);if(state.clipAxis===0)state.clip=0;
  syncUI();renderer?.setSettings(state,interacting);return {...state};
}
$('property').addEventListener('change',e=>applySettings({property:Number(e.target.value)}));
$('block-traversal').addEventListener('change',e=>applySettings({blockTraversal:e.target.checked}));
$('density').addEventListener('input',e=>applySettings({density:Number(e.target.value)},true));
for(const type of ['input','change'])$('surface-transparency').addEventListener(type,e=>applySettings({surfaceTransparency:Number(e.target.value),surfaceOnly:true},type==='input'));
$('surface-only').addEventListener('change',e=>applySettings({surfaceOnly:e.target.checked}));
$('progressive-volume').addEventListener('change',e=>applySettings({progressive:e.target.checked}));
$('edges').addEventListener('change',e=>applySettings({edges:e.target.checked}));
$('interior').addEventListener('change',e=>applySettings({interior:e.target.checked}));
$('line-width').addEventListener('input',e=>applySettings({lineWidth:Number(e.target.value)},true));
$('clip-axis').addEventListener('change',e=>applySettings({clipAxis:Number(e.target.value),clip:Number(e.target.value)>0?(state.clip||35):0}));
$('clip').addEventListener('input',e=>applySettings({clip:Number(e.target.value)},true));
$('porosity-filter').addEventListener('change',e=>applySettings({porosityFilter:e.target.checked}));
for(const key of ['min','max']) {
  const update=(event,interacting)=>{
    const number=event.target.valueAsNumber;
    if(!Number.isFinite(number)){syncUI();return;}
    const [low,high]=phiLimits(),n=Math.round(Math.max(low,Math.min(high,number))*1000)/1000;
    applySettings(key==='min'?{porosityMin:Math.min(n,state.porosityMax)}:{porosityMax:Math.max(n,state.porosityMin)},interacting);
  };
  $('porosity-'+key).addEventListener('change',e=>update(e,false));
  $('porosity-'+key+'-slider').addEventListener('input',e=>update(e,true));
  $('porosity-'+key+'-slider').addEventListener('change',e=>update(e,false));
}
for(const id of ['filter-reset','empty-filter-reset'])$(id).addEventListener('click',()=>{const [porosityMin,porosityMax]=phiLimits();applySettings({porosityFilter:volume?.propertyInfo?volume.propertyInfo[1].available:true,porosityMin,porosityMax});});
document.querySelectorAll('[data-preset]').forEach(b=>b.addEventListener('click',()=>applySettings(presets[b.dataset.preset])));
function markView(view){document.querySelectorAll('[data-view]').forEach(b=>{b.classList.toggle('active',b.dataset.view===view);b.setAttribute('aria-pressed',String(b.dataset.view===view));});}
document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>{renderer?.setView(b.dataset.view);markView(b.dataset.view);}));
$('reset').addEventListener('click',()=>{renderer?.reset();markView('iso');});

function metrics(values){
  if(values.surfaceTransparencyUnavailable){state.surfaceTransparency=0;syncUI();renderer.setSettings(state);return;}
  if(values.phase){
    const messages={pending:'正在更新显示…','surface-pending':'正在缓存筛选与剖切表面，完成后旋转保持清晰…',surface:'正在绘制清晰表面…','opaque-ready':'完全不透明 · 显示完成','surface-only':'正在显示表皮 · 透明度 '+state.surfaceTransparency+'%','surface-ready':'清晰表面 · 旋转复用当前筛选与剖切结果',preview:values.surfacePending?'正在更新筛选与剖切表面…':'正在生成快速预览…',refine:values.progressive?'正在逐块显示内部体积 · 未完成区域保留表皮':'表面保持显示 · 正在计算内部体积','preview-ready':'快速预览 · 正在准备完整画面',ready:values.surfaceReady?'完整体积已显示 · 旋转时显示清晰表面':'完整体积已显示 · 表面缓存不可用，旋转使用快速预览'};
    $('filter-progress').textContent=(messages[values.phase]??'')+(values.phase==='refine'&&values.progress!=null?' · '+Math.round(values.progress*100)+'%':'');
    $('volume-progress').hidden=values.phase!=='refine';$('volume-progress').value=values.progress??0;
  }
  if(values.surfaceGpuBytes!=null&&volume){$('memory-stat').textContent=((volume.stats.gpuBytes+values.surfaceGpuBytes)/1e6).toFixed(1)+' MB';$('memory-stat').title='网格纹理与表面索引；不含画面缓冲、驱动。CPU 表面缓存约 '+((values.surfaceCpuBytes??0)/1e6).toFixed(1)+' MB，另有孔隙度计数索引。';}
  if(!values.width)return;
  $('resolution-stat').textContent=values.width+' × '+values.height+(values.interacting?' · 交互':'');
  $('gpu-stat').textContent=values.gpuMs!=null?values.gpuMs.toFixed(1)+' ms':(values.timerAvailable?'等待计时':'设备未提供 GPU 计时');
}
function disableControls(disabled){
  controlsDisabled=disabled;document.querySelectorAll(controlSelector).forEach(e=>e.disabled=disabled);
  $('volume').inert=disabled;
  if(!disabled){
    syncUI();
    if(renderer?.settings&&renderer.settings.lightMode!==state.lightMode)renderer.setSettings(state);
  }
  syncImportControls();
}
function generateLarge(scale,token){
  return new Promise((resolve,reject)=>{
    worker=new Worker(new URL(scale.startsWith('explicit-')?'./explicit-worker.js':'./large-worker.js',import.meta.url),{type:'module'});
    worker.onmessage=event=>{
      if(token!==loadToken)return;
      const data=event.data;
      if(data.type==='progress')$('loading-text').textContent=(data.phase??'生成 '+scale.toUpperCase()+' 单元属性')+' · '+Math.round(data.fraction*100)+'%';
      if(data.type==='ready'){worker.terminate();worker=null;resolve(data.volume);}
      if(data.type==='error'){worker.terminate();worker=null;reject(new Error(data.message));}
    };
    worker.onerror=()=>{worker?.terminate();worker=null;reject(new Error('网格生成失败，请选择较小的网格规模重试。'));};
    worker.postMessage({scale,backend:webgpuRequested?'webgpu':'webgl'});
  });
}
async function loadModel(scale,prepared){
  if(isLoading)return;
  if(scale!=='legacy'&&!(scale in LARGE_SCALES)&&!(scale in EXPLICIT_SCALES)&&!(scale==='resqml'&&prepared))throw new Error('请在导入区重新选择并加载文件。');
  if(webgpuRequested&&!(scale in EXPLICIT_SCALES)&&scale!=='resqml')throw new Error('WebGPU 实验版支持显式角点模型和 RESQML。');
  const token=++loadToken;isLoading=true;disableControls(true);worker?.terminate();
  $('status').hidden=false;$('volume-progress').hidden=true;$('error').hidden=true;$('empty-filter').hidden=true;$('benchmark-result').textContent='尚未测试';
  $('loading-text').textContent=scale==='legacy'?'正在生成原始网格…':'正在生成 '+scale.toUpperCase()+' 完整网格…';
  try{
    await new Promise(requestAnimationFrame);
    const next=prepared??(scale==='legacy'?buildVolumeData(createSyntheticGrid()):await generateLarge(scale,token));
    if(token!==loadToken)return;
    $('loading-text').textContent='正在准备显卡数据与渲染程序…';
    const camera=!prepared&&volume?.synthetic!==false&&renderer?structuredClone(renderer.camera):null,modified=renderer?.modified??false;
    renderer?.dispose();volume=next;currentScale=scale;filterCacheKey='';
    renderer=scale==='legacy'?new VolumeRenderer($('volume'),volume,reportError):new (webgpuRequested?GPUExplicitRenderer:volume.kind==='explicit'?ExplicitVolumeRenderer:LargeVolumeRenderer)($('volume'),volume,reportError);
    renderer.onMetrics=metrics;await renderer.initialize();
    $('engine-status').textContent=webgpuRequested?'WebGPU · TypeGPU · 实验版':'WebGL2';
    const switchURL=new URL(location.href);switchURL.searchParams.set('backend',webgpuRequested?'webgl':'webgpu');
    if(scale.startsWith('explicit-'))switchURL.searchParams.set('scale',scale);else switchURL.searchParams.delete('scale');
    $('engine-switch').href=switchURL.href;
    $('compare-view').href='./compare.html?backend='+(webgpuRequested?'webgpu':'webgl')+(scale.startsWith('explicit-')?'&scale='+scale:'');
    if(camera){renderer.camera=camera;renderer.modified=modified;if(scale==='legacy')renderer.camera.distance=Math.max(4.3,renderer.camera.distance);}
    renderer.onInteraction=()=>markView('');
    if(renderer.setQuality)renderer.setQuality($('quality').value);
    if(prepared&&!$('model-scale').querySelector('[value="resqml"]'))$('model-scale').add(new Option('已导入 · RESQML','resqml'));
    $('model-scale').value=scale;
    const imported=volume.synthetic===false;
    $('data-source').textContent=imported?'RESQML 文件':'合成数据';$('model-title').textContent=imported?volume.source.title:'断层油藏';
    if(imported){Object.assign(state,{property:Math.max(0,volume.propertyInfo.findIndex(p=>p.available)),porosityFilter:false,porosityMin:0,porosityMax:100,clipAxis:0,clip:0});}
    else{Object.assign(state,{porosityMin:Math.max(8,Math.min(32,state.porosityMin)),porosityMax:Math.max(8,Math.min(32,state.porosityMax))});}
    $('metrics').hidden=scale==='legacy';$('performance-section').hidden=scale==='legacy';
    $('filter-progress').hidden=volume.kind!=='explicit';
    $('model-note').textContent=scale==='legacy'?'小规模四面体邻接遍历，8 角点定义单元。':volume.dims.join(' × ')+' · 全部单元属性已加载';
    $('geometry-description').textContent=scale==='legacy'?'原始演示：2,862 个八角点变形六面体，分解为四面体遍历。':'大规模版本：不等距坐标、分段线性地层起伏、倾斜柱线与两个错动断层块。每个单元都有独立合成属性。';
    if(volume.kind==='explicit'){
      $('model-note').textContent=volume.dims.join(' × ')+' · 有效 '+volume.stats.activeCells.toLocaleString()+' · 非活动 '+volume.stats.inactiveCells.toLocaleString();
      $('geometry-description').textContent='显式 XYZ 角点、三条 X 断层与一条 Y 断层、八个独立断块、非平面单元面。节点逐点变形，断层两侧拆点；非活动单元不参与渲染。';
    }
    $('storage-description').textContent=volume.kind==='explicit'?'角点 XYZ 与三种属性均使用 Float32；共享节点减少重复存储。保留 IJK 邻接，单元面按一致对角线拆成三角形求交。孔隙度按 Float32 值筛选，统计仅含活动单元。':volume.kind==='large'?'紧凑模式使用共享坐标轴、分段线性地层与 8 位属性；孔隙度分辨率约 0.094 个百分点。':'原始演示使用 Float32 角点和属性，每格拆成六个四面体。';
    if(imported){
      $('geometry-description').textContent='RESQML '+volume.source.version+' · '+volume.source.geometry+'；'+volume.source.splitCount+' 条拆点柱线，'+volume.source.gapCount+' 个 K 层间隙。使用文件中的真实角点和活动单元。';
      $('storage-description').textContent='文件局部坐标，XY / Z 原单位 '+volume.source.crs.xyUnit+' / '+volume.source.crs.zUnit+'；统一长度单位、Z 轴向上后平移缩放到显示空间。保留 CRS 元数据，不执行地图投影。';
    }
    if(volume.kind==='large'||volume.kind==='explicit'){
      $('memory-stat').textContent=(volume.stats.gpuBytes/1e6).toFixed(1)+' MB';
      $('memory-stat').title='纹理数据，不含驱动与画布开销。'+(volume.stats.cpuIndexBytes?'CPU 另保留 '+(volume.stats.cpuIndexBytes/1e6).toFixed(1)+' MB 孔隙度计数索引。':'');
      $('load-stat').textContent=(volume.stats.generationMs/1000).toFixed(2)+' s / '+(volume.stats.uploadMs/1000).toFixed(2)+' s';
    }
    $('render-note').textContent=scale==='legacy'?'单元边界积分':'逐格积分 · 无网格聚合';
    applySettings({});if(!camera)markView('iso');await (renderer.drawInitial?.()??renderer.draw());$('status').hidden=true;
  }catch(error){console.error(error);renderer?.dispose();renderer=null;$('engine-status').textContent=webgpuRequested?'WebGPU 初始化失败':'渲染器未就绪';reportError(error);}
  finally{isLoading=false;disableControls(false);}
}
$('model-scale').addEventListener('change',event=>{if(event.target.value==='resqml'){$('model-scale').value=currentScale;$('import-status').textContent='请在导入区选择网格和属性，然后点击“加载并渲染”。';return;}loadModel(event.target.value);});
$('quality').addEventListener('change',event=>{renderer?.setQuality?.(event.target.value);$('benchmark-result').textContent='尚未测试当前分辨率';});
$('benchmark').addEventListener('click',async()=>{
  if(!renderer?.benchmark||isLoading)return;
  disableControls(true);$('benchmark').textContent='正在旋转测试…';$('benchmark-result').textContent='约 3 秒，慢速设备可能更久';
  try{
    const result=await renderer.benchmark();
    if(result)$('benchmark-result').textContent=result.fps.toFixed(1)+' FPS · '+result.width+'×'+result.height+'\n'+result.frames+' 帧 / '+(result.elapsedMs/1000).toFixed(2)+' 秒 · '+result.scale.toUpperCase()+'\n匹配 '+matchedCells.toLocaleString()+' 格 · 体密度 '+state.density+'%';
  }catch(error){reportError(error);}finally{$('benchmark').textContent='测试完整体积帧率';disableControls(false);}
});
async function init(){
  $('engine-switch').textContent=webgpuRequested?'返回 WebGL2':'试用 WebGPU';
  $('engine-switch').href=webgpuRequested?'?backend=webgl':'?backend=webgpu';
  $('engine-status').textContent=webgpuRequested?'正在初始化 WebGPU…':'正在初始化 WebGL2…';
  if(webgpuRequested){
    for(const group of $('model-scale').querySelectorAll('optgroup'))if(group.querySelector('[value="legacy"]'))group.remove();
    try{
      if(!navigator.gpu)throw new Error('当前浏览器未开放 WebGPU。请启用硬件加速并使用支持 WebGPU 的浏览器，或点击左侧“返回 WebGL2”。');
      ({WebGPUVolumeRenderer:GPUExplicitRenderer}=await import('./webgpu-renderer.js'));
    }catch(error){$('engine-status').textContent='WebGPU 未就绪';disableControls(true);reportError(error);return;}
  }
  const requestedScale=parameters.get('scale');
  await loadModel(requestedScale in EXPLICIT_SCALES?requestedScale:webgpuRequested?'explicit-1m':'explicit-10m');registerTools();
}

let importWorker=null,importCatalog=null,importBusy=false,importPending=null;
function syncImportControls(){
  const busy=controlsDisabled||importBusy||isLoading;
  document.querySelectorAll('#resqml-files,#import-options input,#import-options select,#import-options button').forEach(e=>e.disabled=busy);
  const selected=importCatalog?.grids.find(g=>g.uuid===$('import-grid').value);
  $('import-render').disabled=busy||!importWorker||!selected||!!selected.reason;
  $('import-cancel').hidden=!importBusy;$('import-cancel').disabled=false;
}
function fillImportProperties(){
  const grid=importCatalog.grids.find(g=>g.uuid===$('import-grid').value);if(!grid)return;
  const props=importCatalog.properties.filter(p=>p.support===grid.uuid);
  const guesses={phi:/porosity|poro\b|孔隙|^phi$/i,so:/oil saturation|\bso\b|\bsoil\b|含油/i,k:/permeability|\bperm\b|渗透/i,active:/\bactive\b|\binactive\b|actnum|活动/i};
  for(const key of ['phi','so','k','active']){
    const select=$('import-'+key);select.replaceChildren(new Option(key==='active'?'使用几何有效标志':'不加载此属性',''));
    for(const p of props){if(key!=='active'&&p.discrete)continue;select.add(new Option(p.title+(p.uom?' ['+p.uom+']':'')+(p.timeIndex!==''?' · 时间 '+p.timeIndex:'')+' · '+p.uuid.slice(0,8),p.uuid));}
    const matches=props.filter(p=>(key==='active'||!p.discrete)&&guesses[key].test(p.kind+' '+p.title));
    if(matches.length===1)select.value=matches[0].uuid;
  }
  $('import-phi-unit').value='auto';
  syncActiveMode();
  $('import-status').textContent=grid.reason||grid.dims.join(' × ')+' · '+(grid.dims.reduce((a,b)=>a*b,1)).toLocaleString()+' 格。选择要加载的属性；同名或多时刻属性请手动确认。';
  syncImportControls();
}
$('import-grid').addEventListener('change',fillImportProperties);
function syncActiveMode(){const p=importCatalog?.properties.find(p=>p.uuid===$('import-active').value);$('import-active-mode').value=p&&/\binactive\b/i.test(p.title+' '+p.kind)?'zero':'positive';}
$('import-active').addEventListener('change',syncActiveMode);
$('resqml-files').addEventListener('change',()=>{
  const files=Array.from($('resqml-files').files);if(!files.length)return;
  importWorker?.terminate();importCatalog=null;importBusy=true;$('import-options').hidden=true;syncImportControls();
  $('import-status').textContent='正在读取 EPC 中的网格、属性和文件关联…';
  importWorker=new Worker(new URL('./resqml-worker.js',import.meta.url),{type:'module'});
  importWorker.onmessage=event=>{
    const data=event.data;
    if(data.type==='catalog'){importCatalog=data.catalog;importBusy=false;$('import-options').hidden=false;$('import-grid').replaceChildren(...importCatalog.grids.map(g=>new Option(g.title+' · '+g.dims.join('×')+(g.reason?' · 暂不支持':''),g.uuid)));fillImportProperties();}
    else if(data.type==='progress'){$('loading-text').textContent=data.phase+' · '+Math.round(data.fraction*100)+'%';$('import-status').textContent=$('loading-text').textContent;}
    else if(data.type==='ready'){const pending=importPending;importPending=null;pending?.resolve(data.volume);}
    else if(data.type==='error'){
      if(importPending){const pending=importPending;importPending=null;pending.reject(new Error(data.message));}
      else{importBusy=false;$('import-status').textContent=data.message;syncImportControls();}
    }
  };
  importWorker.onerror=()=>{
    const error=new Error('文件读取器中断，可能是内存不足或文件编码不支持。请重新选择文件，或导出较小的网格重试。');
    if(importPending){const p=importPending;importPending=null;p.reject(error);}else{importBusy=false;$('import-status').textContent=error.message;syncImportControls();}
    importWorker?.terminate();importWorker=null;
    importCatalog=null;$('import-options').hidden=true;$('resqml-files').value='';syncImportControls();
  };
  importWorker.postMessage({type:'inspect',files});
});
$('import-cancel').addEventListener('click',()=>{
  importWorker?.terminate();importWorker=null;importBusy=false;importCatalog=null;$('import-options').hidden=true;
  const pending=importPending;importPending=null;pending?.reject(new Error('已取消导入。重新选择文件即可重试。'));
  $('import-status').textContent='已取消导入。重新选择文件即可重试。';$('resqml-files').value='';syncImportControls();
});
$('import-render').addEventListener('click',async()=>{
  if(!importWorker||!importCatalog||isLoading||importBusy)return;
  const gl=renderer?.gl,limits=renderer?.getImportLimits?.()??(gl?{max3d:gl.getParameter(gl.MAX_3D_TEXTURE_SIZE),max2d:gl.getParameter(gl.MAX_TEXTURE_SIZE)}:null);
  if(!limits){$('import-status').textContent='请先恢复三维视图，再导入文件。';return;}
  const selection={grid:$('import-grid').value,phiUnit:$('import-phi-unit').value,activeMode:$('import-active-mode').value};for(const key of ['phi','so','k','active'])selection[key]=$('import-'+key).value;
  isLoading=true;importBusy=true;disableControls(true);renderer.invalidate?.();$('volume-progress').hidden=true;$('status').hidden=false;$('loading-text').textContent='正在解析 RESQML…';
  try{
    const ready=new Promise((resolve,reject)=>{importPending={resolve,reject};});
    importWorker.postMessage({type:'load',selection,limits,backend:webgpuRequested?'webgpu':'webgl'});
    const next=await ready;importWorker.terminate();importWorker=null;importBusy=false;isLoading=false;
    await loadModel('resqml',next);
    if(renderer&&volume===next)$('import-status').textContent='已加载 '+next.source.title+' · '+next.stats.activeCells.toLocaleString()+' 个活动单元。'+next.source.warnings.join(' ');
    // Arrays are no longer retained in the worker after GPU upload. A fresh
    // selection makes reload ownership and memory usage explicit.
    importCatalog=null;$('import-options').hidden=true;$('resqml-files').value='';
  }catch(error){$('import-status').textContent=error.message;$('status').hidden=true;renderer?.requestRender();}
  finally{isLoading=false;importBusy=false;disableControls(false);}
});

// Optional browser-provided WebMCP: the visible controls are the source of truth.
function registerTools() {
  const context=document.modelContext;if(!context?.registerTool)return;
  const lifecycle=new AbortController();window.addEventListener('pagehide',()=>lifecycle.abort(),{once:true});
  const register=tool=>{try{Promise.resolve(context.registerTool(tool,{signal:lifecycle.signal})).catch(e=>console.warn('WebMCP registration unavailable',e));}catch(e){console.warn('WebMCP unavailable',e);}};
  register({name:'get_reservoir_display',title:'读取油藏显示设置',description:'读取当前显示、孔隙度筛选范围和剖切前的匹配单元数。',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:true},execute:()=>({backend:webgpuRequested?'webgpu':'webgl2',settings:{...state},cells:volume.stats.cells,activeCells:volume.stats.activeCells??volume.stats.cells,matchingCellsBeforeClipping:matchedCells,synthetic:volume.synthetic!==false,source:volume.source??null,porosityLimits:phiLimits(),scale:currentScale,gpuDataBytes:volume.stats.gpuBytes??null})});
  register({name:'configure_reservoir_display',title:'调整油藏显示',description:'更新显示和独立孔隙度筛选。surfaceTransparency: 0–100 表皮透明度；surfaceOnly: 是否停留在表皮，只有显式模型支持。progressive: 表皮就绪后逐块显示完整体积。property: 0 含油饱和度、1 孔隙度、2 渗透率；clipAxis: 0 关闭、1 X、2 Y、3 Z。porosityMin/Max 为百分数，合成模型范围 8 到 32，导入模型范围 0 到 100，包含端点，下限不可大于上限；关闭 porosityFilter 显示全部活动单元。',inputSchema:{type:'object',properties:{property:{type:'integer',minimum:0,maximum:2},density:{type:'number',minimum:0,maximum:100},surfaceTransparency:{type:'number',minimum:0,maximum:100},surfaceOnly:{type:'boolean'},progressive:{type:'boolean'},edges:{type:'boolean'},lineWidth:{type:'number',minimum:.5,maximum:2.5},interior:{type:'boolean'},clipAxis:{type:'integer',minimum:0,maximum:3},clip:{type:'number',minimum:0,maximum:90},porosityFilter:{type:'boolean'},porosityMin:{type:'number',minimum:0,maximum:100},porosityMax:{type:'number',minimum:0,maximum:100}},additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false},async execute(input){const settings=applySettings(input);await new Promise(requestAnimationFrame);return {settings,matchingCellsBeforeClipping:matchedCells};}});
}
window.addEventListener('pagehide',()=>{worker?.terminate();importWorker?.terminate();renderer?.dispose();},{once:true});
window.addEventListener('pageshow',e=>{if(e.persisted)location.reload();});
init();
