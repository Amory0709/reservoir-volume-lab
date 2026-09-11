import {createSyntheticGrid,buildVolumeData} from './mesh.js';
import {VolumeRenderer} from './renderer.js';
import {LargeVolumeRenderer} from './large-renderer.js';
import {ExplicitVolumeRenderer} from './explicit-renderer.js';
import {EXPLICIT_SCALES,countExplicitMatches} from './explicit-grid.js';
import {LARGE_SCALES,countLargeMatches} from './large-grid.js';
import {porosityBounds,countPorosityMatches} from './filter.js';

const $=id=>document.getElementById(id);
const state={property:0,density:60,edges:true,lineWidth:1.2,interior:true,clipAxis:0,clip:0,porosityFilter:true,porosityMin:8,porosityMax:32};
const presets={solid:{density:60,edges:true,interior:true,clipAxis:0,clip:0},volume:{density:15,edges:true,interior:true,clipAxis:0,clip:0},cut:{density:76,edges:true,interior:true,clipAxis:1,clip:38}};
const properties=[
  {name:'含油饱和度',unit:'So · 无量纲',ticks:['0.05','0.25','0.45','0.65','0.85'],note:'单元内保持常值，保留属性突变。'},
  {name:'孔隙度',unit:'φ · %',ticks:['8','14','20','26','32'],note:'各单元独立着色，无跨单元平滑。'},
  {name:'渗透率',unit:'K · mD · 对数',ticks:['0.5','3.7','27','203','1,500'],note:'对数色标显示合成高渗通道。'}
];
let renderer,volume,filterCacheKey='',matchedCells=0,worker,loadToken=0,currentScale='explicit-10m',isLoading=false;
const phiLimits=()=>volume?.synthetic===false?[0,100]:[8,32];
function propertyDisplay(slot){
  const p=volume?.propertyInfo?.[slot];if(!p)return properties[slot];
  if(!p.available)return {name:'网格几何',unit:'未加载此属性',ticks:['—','—','—','—','—'],note:'灰色显示真实几何；可在导入区选择属性后重新加载。'};
  const factor=slot===1?100:1,ticks=Array.from({length:5},(_,i)=>{const n=(p.log?Math.exp(Math.log(p.min)+(Math.log(p.max)-Math.log(p.min))*i/4):p.min+(p.max-p.min)*i/4)*factor;return Number(n.toPrecision(4)).toLocaleString(undefined,{maximumSignificantDigits:4});});
  return {name:p.title,unit:p.unit+(p.log?' · 对数':''),ticks,note:p.missing?'缺失属性的活动单元显示为灰色。':'文件原始属性；色标按活动单元的有效值范围显示。'};
}
function reportError(error){$('status').hidden=true;$('error-text').textContent=error.message||'请重新加载后重试。';$('error').hidden=false;}
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
  $('property').value=String(state.property);$('density').value=state.density;$('density-value').textContent=state.density+'%';
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
}
function applySettings(patch,interacting=false) {
  if(!patch||typeof patch!=='object'||Array.isArray(patch))throw new Error('设置必须为对象。');
  if(isLoading&&Object.keys(patch).length)throw new Error('请等待网格加载完成。');
  const ranges={property:[0,2,true],density:[0,100,false],lineWidth:[.5,2.5,false],clipAxis:[0,3,true],clip:[0,90,false],porosityMin:[...phiLimits(),false],porosityMax:[...phiLimits(),false]};
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
  if(renderer?.benchmarking)throw new Error('请等待性能测试完成后再修改设置。');
  if(Object.keys(patch).length)$('benchmark-result').textContent='尚未测试当前设置';
  Object.assign(state,patch);if(state.clipAxis===0)state.clip=0;
  syncUI();renderer?.setSettings(state,interacting);return {...state};
}
$('property').addEventListener('change',e=>applySettings({property:Number(e.target.value)}));
$('density').addEventListener('input',e=>applySettings({density:Number(e.target.value)},true));
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
  if(values.phase){
    const messages={pending:'正在更新显示…',preview:'正在生成表面预览…',refine:'正在恢复完整体积与内部边线…','preview-ready':'表面预览 · 停止操作后恢复体积',ready:'显示已更新'};
    $('filter-progress').textContent=messages[values.phase]??'';
  }
  if(!values.width)return;
  $('resolution-stat').textContent=values.width+' × '+values.height+(values.interacting?' · 交互':'');
  $('gpu-stat').textContent=values.gpuMs!=null?values.gpuMs.toFixed(1)+' ms':(values.timerAvailable?'等待计时':'设备未提供 GPU 计时');
}
function disableControls(disabled){
  document.querySelectorAll('.panel input,.panel select,.panel button,.view-tools button,#empty-filter-reset').forEach(e=>e.disabled=disabled);
  $('volume').inert=disabled;
  if(!disabled)syncUI();
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
    worker.postMessage({scale});
  });
}
async function loadModel(scale,prepared){
  if(isLoading)return;
  if(scale!=='legacy'&&!(scale in LARGE_SCALES)&&!(scale in EXPLICIT_SCALES)&&!(scale==='resqml'&&prepared))throw new Error('请在导入区重新选择并加载文件。');
  const token=++loadToken;isLoading=true;disableControls(true);worker?.terminate();
  $('status').hidden=false;$('error').hidden=true;$('empty-filter').hidden=true;$('benchmark-result').textContent='尚未测试';
  $('loading-text').textContent=scale==='legacy'?'正在生成原始网格…':'正在生成 '+scale.toUpperCase()+' 完整网格…';
  try{
    await new Promise(requestAnimationFrame);
    const next=prepared??(scale==='legacy'?buildVolumeData(createSyntheticGrid()):await generateLarge(scale,token));
    if(token!==loadToken)return;
    $('loading-text').textContent='正在准备显卡数据与渲染程序…';
    const camera=!prepared&&volume?.synthetic!==false&&renderer?structuredClone(renderer.camera):null,modified=renderer?.modified??false;
    renderer?.dispose();volume=next;currentScale=scale;filterCacheKey='';
    renderer=scale==='legacy'?new VolumeRenderer($('volume'),volume,reportError):new (volume.kind==='explicit'?ExplicitVolumeRenderer:LargeVolumeRenderer)($('volume'),volume,reportError);
    renderer.onMetrics=metrics;await renderer.initialize();
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
    applySettings({});if(!camera)markView('iso');await renderer.draw();$('status').hidden=true;
  }catch(error){console.error(error);renderer?.dispose();renderer=null;reportError(error);}
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
async function init(){await loadModel('explicit-10m');registerTools();}

let importWorker=null,importCatalog=null,importBusy=false,importPending=null;
function syncImportControls(){
  document.querySelectorAll('#resqml-files,#import-options input,#import-options select,#import-options button').forEach(e=>e.disabled=importBusy||isLoading);
  const selected=importCatalog?.grids.find(g=>g.uuid===$('import-grid').value);
  $('import-render').disabled=importBusy||isLoading||!importWorker||!selected||!!selected.reason;
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
  const gl=renderer?.gl;if(!gl){$('import-status').textContent='请先恢复 WebGL 三维视图，再导入文件。';return;}
  const selection={grid:$('import-grid').value,phiUnit:$('import-phi-unit').value,activeMode:$('import-active-mode').value};for(const key of ['phi','so','k','active'])selection[key]=$('import-'+key).value;
  isLoading=true;importBusy=true;disableControls(true);renderer.invalidate?.();$('status').hidden=false;$('loading-text').textContent='正在解析 RESQML…';
  try{
    const ready=new Promise((resolve,reject)=>{importPending={resolve,reject};});
    importWorker.postMessage({type:'load',selection,limits:{max3d:gl.getParameter(gl.MAX_3D_TEXTURE_SIZE),max2d:gl.getParameter(gl.MAX_TEXTURE_SIZE)}});
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
  register({name:'get_reservoir_display',title:'读取油藏显示设置',description:'读取当前显示、孔隙度筛选范围和剖切前的匹配单元数。',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:true},execute:()=>({settings:{...state},cells:volume.stats.cells,activeCells:volume.stats.activeCells??volume.stats.cells,matchingCellsBeforeClipping:matchedCells,synthetic:volume.synthetic!==false,source:volume.source??null,porosityLimits:phiLimits(),scale:currentScale,gpuDataBytes:volume.stats.gpuBytes??null})});
  register({name:'configure_reservoir_display',title:'调整油藏显示',description:'更新显示和独立孔隙度筛选。property: 0 含油饱和度、1 孔隙度、2 渗透率；clipAxis: 0 关闭、1 X、2 Y、3 Z。porosityMin/Max 为百分数，合成模型范围 8 到 32，导入模型范围 0 到 100，包含端点，下限不可大于上限；关闭 porosityFilter 显示全部活动单元。',inputSchema:{type:'object',properties:{property:{type:'integer',minimum:0,maximum:2},density:{type:'number',minimum:0,maximum:100},edges:{type:'boolean'},lineWidth:{type:'number',minimum:.5,maximum:2.5},interior:{type:'boolean'},clipAxis:{type:'integer',minimum:0,maximum:3},clip:{type:'number',minimum:0,maximum:90},porosityFilter:{type:'boolean'},porosityMin:{type:'number',minimum:0,maximum:100},porosityMax:{type:'number',minimum:0,maximum:100}},additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false},async execute(input){const settings=applySettings(input);await new Promise(requestAnimationFrame);return {settings,matchingCellsBeforeClipping:matchedCells};}});
}
window.addEventListener('pagehide',()=>{worker?.terminate();importWorker?.terminate();renderer?.dispose();},{once:true});
window.addEventListener('pageshow',e=>{if(e.persisted)location.reload();});
init();
