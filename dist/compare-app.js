import {ComparisonRenderer} from './comparison-renderer.js';
import {EXPLICIT_SCALES,countExplicitMatches} from './explicit-grid.js';
const $=id=>document.getElementById(id),params=new URLSearchParams(location.search),backend=params.get('backend')==='webgpu'?'webgpu':'webgl';
let session=null,volume=null,isLoading=false,worker=null,scale='explicit-10m';
const base={blockTraversal:params.get('blocks')==='1',lightMode:document.documentElement.dataset.theme==='light',progressive:false,property:0,density:60,edges:true,lineWidth:1.2,interior:true,surfaceTransparency:0,clipAxis:0,clip:0,porosityFilter:true,porosityMin:8,porosityMax:32};
const propertyLabels=['含油饱和度','孔隙度','渗透率'];
const views=['volume','surface'].map(id=>({id,settings:{...base,surfaceOnly:id==='surface'},quality:'detail'}));
function createPane(view){
  const id=view.id,isVolume=id==='volume',name=isVolume?'体渲染':'表皮渲染',other=isVolume?'右侧':'左侧';
  const select=(key,label,options)=>`<label class="field" for="${id}-${key}">${label}<select id="${id}-${key}" data-setting="${key}">${options}</select></label>`;
  const check=(key,label)=>`<label class="check-label"><input id="${id}-${key}" data-setting="${key}" type="checkbox">${label}</label>`;
  const slider=(key,label,min,max,step)=>`<div><div class="field-row"><label for="${id}-${key}">${label}</label><output id="${id}-${key}-value" for="${id}-${key}"></output></div><input id="${id}-${key}" data-setting="${key}" type="range" min="${min}" max="${max}" step="${step}"></div>`;
  const pane=document.createElement('section');pane.className='pane';pane.dataset.kind=id;pane.setAttribute('aria-label',name);
  pane.innerHTML=`<header class="pane-heading"><div><h2>${name}<span>${isVolume?'VOLUME':'SURFACE'}</span></h2><span class="pane-subtitle">${isVolume?'沿光线累积内部单元':'只画外露面与剖切面'}</span></div><div class="view-buttons" role="group" aria-label="${name}视角"><button data-view="iso" title="等轴测视角">3D</button><button data-view="top" title="俯视">顶</button><button data-view="front" title="正视">正</button><button data-view="reset" aria-label="复位视角">↺</button></div></header>
  <div id="${id}-stage" class="stage" tabindex="0" aria-label="${name}。拖动旋转，滚轮缩放，Shift 拖动平移；方向键旋转，加减号缩放，R 复位。"><div class="stage-info"><output id="${id}-state" class="render-state" aria-live="polite">等待共享数据…</output><output id="${id}-stat" class="render-stat"></output></div><div id="${id}-message" class="stage-message">正在准备同一份网格…</div><div class="legend"><div class="legend-title"><span id="${id}-legend-name"></span><span id="${id}-legend-unit" class="legend-unit"></span></div><div class="colorbar"></div><div id="${id}-legend-ticks" class="legend-ticks"></div></div><div class="stage-hint">拖动旋转 · 滚轮缩放 · Shift 拖动平移</div><progress id="${id}-progress" class="render-progress" max="1" value="0" aria-label="${name}计算进度" hidden></progress></div>
  <div class="pane-controls" aria-label="${name}独立控件"><div class="control-column">
    ${select('property','显示属性',propertyLabels.map((label,i)=>`<option value="${i}">${label}</option>`).join(''))}
    ${isVolume?slider('density','体密度',0,100,1):slider('surfaceTransparency','表皮透明度',0,100,1)}
    ${check('edges','保留网格线')}${slider('lineWidth','线宽',.5,2.5,.1)}
    ${isVolume?check('interior','显示内部边线'):'<p class="control-note">透明度 100% 时，开启网格线可看线框。</p>'}
  </div><div class="control-column">
    ${check('porosityFilter','孔隙度筛选')}
    <div class="phi-values"><label>下限<input id="${id}-porosityMin" data-setting="porosityMin" type="number" min="8" max="32" step="0.1" aria-label="${name}孔隙度下限"></label><span>—</span><label>上限<input id="${id}-porosityMax" data-setting="porosityMax" type="number" min="8" max="32" step="0.1" aria-label="${name}孔隙度上限"></label><span>%</span></div><output id="${id}-count" class="count"></output>
    ${select('clipAxis','剖切方向','<option value="0">不剖切</option><option value="1">X 方向</option><option value="2">Y 方向</option><option value="3">Z 方向</option>')}${slider('clip','裁去比例',0,90,1)}
  </div><div class="control-column">
    ${select('quality',isVolume?'体积清晰度':'表皮清晰度','<option value="fast">流畅 · 24 万像素</option><option value="balanced">均衡 · 52 万像素</option><option value="detail" selected>精细 · 120 万像素</option>')}
    ${isVolume&&backend==='webgl'?check('blockTraversal','分块加速（实验）'):''}
    <p class="control-note">${isVolume?'低于 100% 时计算透明体积；100% 时直接显示不透明表皮，保留网格线。':'始终显示表皮。筛选或剖切后会更新外露面，旋转复用当前结果。'}</p>
    <button class="copy-settings" type="button" data-copy>将本侧条件应用到${other}</button><p class="control-note">复制属性、筛选、剖切、网格线和清晰度。</p>
  </div></div>`;
  $('comparison').append(pane);view.root=pane;view.element=$(`${id}-stage`);
  pane.querySelectorAll('[data-setting]').forEach(control=>control.addEventListener(control.type==='range'?'input':'change',()=>{
    if(!session||isLoading)return;
    const key=control.dataset.setting;
    if(key==='quality'){session.setQuality(view,control.value);return;}
    let value=control.type==='checkbox'?control.checked:Number(control.value);
    if(typeof value==='number'&&!Number.isFinite(value)){syncUI(view);return;}
    const patch={[key]:value};
    if(key==='porosityMin'||key==='porosityMax'){
      const [lo,hi]=volume.synthetic===false?[0,100]:[8,32];value=Math.max(lo,Math.min(hi,value));
      patch[key]=key==='porosityMin'?Math.min(value,view.settings.porosityMax):Math.max(value,view.settings.porosityMin);
    }
    if(key==='clipAxis')patch.clip=value?(view.settings.clip||35):0;
    session.setSettings(view,patch);syncUI(view);
  }));
  pane.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>{if(!session||isLoading)return;const c=view.controller;button.dataset.view==='reset'?c.reset():c.setView(button.dataset.view);}));
  pane.querySelector('[data-copy]').addEventListener('click',()=>{
    if(!session||isLoading)return;
    const otherView=views.find(v=>v!==view),patch=Object.fromEntries(['property','porosityFilter','porosityMin','porosityMax','clipAxis','clip','edges','lineWidth'].map(key=>[key,view.settings[key]]));
    session.setQuality(otherView,view.quality);session.setSettings(otherView,patch);syncUI(otherView);
  });
}
views.forEach(createPane);
function syncUI(view){
  const s=view.settings,prefix=view.id+'-',hasPhi=volume?.propertyInfo?volume.propertyInfo[1].available:true;
  for(const control of view.root.querySelectorAll('[data-setting]')){
    const key=control.dataset.setting;control.disabled=isLoading||!session;
    if(key==='quality')control.value=view.quality;else if(control.type==='checkbox')control.checked=s[key];else control.value=s[key];
  }
  if(!isLoading&&session){
    $(prefix+'porosityFilter').disabled=!hasPhi;
    for(const key of ['porosityMin','porosityMax'])$(prefix+key).disabled=!hasPhi||!s.porosityFilter;
    $(prefix+'lineWidth').disabled=!s.edges;$(prefix+'clip').disabled=s.clipAxis===0;
    if(view.id==='volume')$(prefix+'interior').disabled=!s.edges;
    else $(prefix+'surfaceTransparency').disabled=!view.surface?.transparencySupported;
  }
  for(const key of ['porosityMin','porosityMax']){const c=$(prefix+key);c.min=volume?.synthetic===false?0:8;c.max=volume?.synthetic===false?100:32;}
  $(prefix+'clip-value').textContent=s.clip+'%';$(prefix+'lineWidth-value').textContent=s.lineWidth.toFixed(1)+' px';
  const special=view.id==='volume'?'density':'surfaceTransparency';$(prefix+special+'-value').textContent=special==='density'&&s.density===100?'100% · 不透明':s[special]+'%';
  const info=volume?.propertyInfo?.[s.property];
  let ticks=[['0.05','0.25','0.45','0.65','0.85'],['8','14','20','26','32'],['0.5','3.7','27','203','1,500']][s.property];
  if(info)ticks=info.available?Array.from({length:5},(_,i)=>{const n=info.log?Math.exp(Math.log(info.min)+(Math.log(info.max)-Math.log(info.min))*i/4):info.min+(info.max-info.min)*i/4;return Number((n*(s.property===1?100:1)).toPrecision(3)).toLocaleString();}):['—','—','—','—','—'];
  $(prefix+'legend-name').textContent=info?(info.available?info.title:'网格几何'):propertyLabels[s.property];
  $(prefix+'legend-unit').textContent=info?(info.unit??''):['So','φ · %','K · mD'][s.property];
  $(prefix+'legend-ticks').replaceChildren(...ticks.map(text=>{const span=document.createElement('span');span.textContent=text;return span;}));
  for(const option of $(prefix+'property').options){const property=volume?.propertyInfo?.[Number(option.value)];option.disabled=!!property&&!property.available&&(volume.propertyInfo.some(p=>p.available)||option.value!=='0');option.textContent=property?(property.available?property.title:Number(option.value)===0&&!volume.propertyInfo.some(p=>p.available)?'网格几何':'未加载 · '+propertyLabels[Number(option.value)]):propertyLabels[Number(option.value)];}
  if(volume){
    const count=countExplicitMatches(volume,s);view.matchingCells=count;$(prefix+'count').textContent=count.toLocaleString()+' / '+volume.stats.activeCells.toLocaleString()+' 格 · 剖切前';
  }
}
function metrics(view,data){
  const prefix=view.id+'-';
  if(data.phase){
    view.lastPhase=data.phase;
    if(data.phase==='surface'){view.lastVolumeMs=null;view.lastGpuMs=null;}
    const label={pending:'正在更新本侧显示…','surface-pending':'正在更新筛选与剖切表皮…',surface:'正在绘制表皮…','opaque-ready':'完全不透明 · 完成','surface-only':'表皮 · 完成','surface-ready':view.id==='volume'?'表皮预览 · 等待完整体积':'表皮 · 完成',refine:'体积计算中 · '+Math.round((data.progress??0)*100)+'%','preview':'正在生成交互预览…','preview-ready':'交互预览',ready:'完整体积 · 完成'}[data.phase]??data.phase;
    $(prefix+'state').textContent=label;const progress=$(prefix+'progress');progress.hidden=data.phase!=='refine';progress.value=data.progress??0;
    if(['surface-ready','surface-only','opaque-ready','ready'].includes(data.phase)){
      $(prefix+'message').hidden=view.matchingCells!==0;
      $(prefix+'message').textContent='没有匹配单元，请调宽本侧孔隙度范围。';
    }else if(!view.displayTarget){$(prefix+'message').hidden=false;$(prefix+'message').textContent=label;}
  }
  if(data.width){view.lastSize=[data.width,data.height];view.lastMs=data.surfaceMs??data.gpuMs??null;view.lastTimingLabel=data.surfaceMs!=null?'表皮 ':'GPU ';}
  if(data.volumeMs!=null){view.lastVolumeMs=data.volumeMs;view.lastGpuMs=data.gpuMs;}
  if(data.completedMs!=null)view.lastVolumeMs=data.completedMs;
  if(view.lastSize){
    const timing=view.lastPhase==='ready'&&view.lastVolumeMs!=null?'\n体积 '+(view.lastVolumeMs/1000).toFixed(2)+' s'+(view.lastGpuMs!=null?' · GPU '+view.lastGpuMs.toFixed(1)+' ms':''):view.lastMs!=null?'\n'+view.lastTimingLabel+view.lastMs.toFixed(1)+' ms':'';
    $(prefix+'stat').textContent=view.lastSize.join(' × ')+timing;
  }
}
function errorMessage(error,view){
  if(view){$(view.id+'-state').textContent='本侧显示失败';$(view.id+'-message').hidden=false;$(view.id+'-message').textContent=error.message;$(view.id+'-progress').hidden=true;}
  else{setLoadingText(error.message,true);for(const v of views){$(v.id+'-message').hidden=false;$(v.id+'-message').textContent='三维视图未就绪，请降低规模或重新加载。';}}
}
function setLoadingText(text,error=false){$('load-message').hidden=false;$('load-message').textContent=text;$('load-message').dataset.error=String(error);}
function disableControls(disabled){
  document.querySelectorAll('.pane-controls input,.pane-controls select,.pane-controls button,.view-buttons button,#model-scale,#sync-camera,#open-import,#theme-toggle').forEach(el=>el.disabled=disabled);
  for(const v of views){v.element.inert=disabled;syncUI(v);}syncImportControls();
}
function generate(requested){return new Promise((resolve,reject)=>{
  worker=new Worker(new URL('./explicit-worker.js',import.meta.url),{type:'module'});
  worker.onmessage=({data})=>{if(data.type==='progress')setLoadingText((data.phase??'生成共享网格')+' · '+Math.round(data.fraction*100)+'%');else if(data.type==='ready'){worker.terminate();worker=null;resolve(data.volume);}else if(data.type==='error'){worker.terminate();worker=null;reject(new Error(data.message));}};
  worker.onerror=()=>{worker?.terminate();worker=null;reject(new Error('网格生成失败，请选择较小规模重试。'));};worker.postMessage({scale:requested,backend});
});}
async function loadModel(requested,prepared){
  if(isLoading)return;isLoading=true;disableControls(true);setLoadingText('正在加载两侧共用的网格…');
  try{
    if(backend==='webgpu'&&!navigator.gpu)throw new Error('当前浏览器未开放 WebGPU。请点击“返回 WebGL2”继续。');
    const next=prepared??await generate(requested);
    const cameras=views.map(v=>v.controller?{camera:structuredClone(v.controller.camera),modified:v.controller.modified}:null);
    await session?.dispose();session=null;volume=next;scale=requested;
    for(const view of views){
      view.front=null;view.displayTarget=null;view.failed=false;view.lastSize=null;view.lastMs=null;view.lastVolumeMs=null;view.lastGpuMs=null;view.lastPhase=null;
      view.settings={...view.settings,surfaceOnly:view.id==='surface',lightMode:document.documentElement.dataset.theme==='light'};
      if(prepared)Object.assign(view.settings,{property:Math.max(0,next.propertyInfo.findIndex(p=>p.available)),porosityFilter:false,porosityMin:0,porosityMax:100,clipAxis:0,clip:0});
      else Object.assign(view.settings,{porosityMin:Math.max(8,Math.min(32,view.settings.porosityMin)),porosityMax:Math.max(8,Math.min(32,view.settings.porosityMax))});
      $(view.id+'-message').hidden=false;$(view.id+'-message').textContent='正在准备共享显卡数据…';$(view.id+'-stat').textContent='';$(view.id+'-progress').hidden=true;
    }
    setLoadingText('只上传一份网格，正在准备体积与表皮…');
    session=new ComparisonRenderer($('shared-canvas'),volume,views,{backend,onMetrics:metrics,onError:errorMessage});
    await session.initialize();session.linked=$('sync-camera').checked;
    if(!prepared)for(let i=0;i<views.length;i++)if(cameras[i]){views[i].controller.camera=cameras[i].camera;views[i].controller.modified=cameras[i].modified;session.invalidate(views[i]);}
    if(prepared&&!$('model-scale').querySelector('[value="resqml"]'))$('model-scale').add(new Option('已导入 · RESQML','resqml'));
    $('model-scale').value=scale;$('dataset-label').textContent=(prepared?volume.source.title:'断层油藏')+' · '+volume.dims.join(' × ')+' · '+volume.stats.cells.toLocaleString()+' 格';
    $('shared-memory').textContent='共享网格 '+(volume.stats.gpuBytes/1e6).toFixed(1)+' MB';$('shared-memory').title='网格纹理只上传一次；两侧表皮索引和画面缓冲另占显存。';
    $('engine-status').textContent=backend==='webgpu'?'WebGPU · TypeGPU':'WebGL2';
    const query='?backend='+backend+(scale.startsWith('explicit-')?'&scale='+scale:'');$('single-view').href='./'+query;
    $('engine-switch').href='?backend='+(backend==='webgpu'?'webgl':'webgpu')+(scale.startsWith('explicit-')?'&scale='+scale:'');
    $('load-message').hidden=true;session.resize();
  }catch(error){await session?.dispose();session=null;errorMessage(error);}
  finally{isLoading=false;disableControls(false);}
}
$('engine-switch').textContent=backend==='webgpu'?'返回 WebGL2':'试用 WebGPU';$('engine-switch').href='?backend='+(backend==='webgpu'?'webgl':'webgpu');
$('model-scale').addEventListener('change',()=>{if($('model-scale').value==='resqml'){$('model-scale').value=scale;$('import-dialog').showModal();return;}loadModel($('model-scale').value);});
$('sync-camera').addEventListener('change',()=>session?.setLinked($('sync-camera').checked));
document.addEventListener('reservoir-theme-change',({detail})=>{for(const v of views){if(session&&!isLoading)session.setSettings(v,{lightMode:detail.lightMode});else v.settings={...v.settings,lightMode:detail.lightMode};}});
$('open-import').addEventListener('click',()=>$('import-dialog').showModal());

let importWorker=null,importCatalog=null,importBusy=false,importPending=null;
function syncImportControls(){
  const busy=isLoading||importBusy;
  document.querySelectorAll('#resqml-files,#import-options input,#import-options select,#import-options button').forEach(el=>el.disabled=busy);
  const selected=importCatalog?.grids.find(g=>g.uuid===$('import-grid').value);$('import-render').disabled=busy||!session||!selected||!!selected.reason;
  $('import-cancel').hidden=!importBusy;$('import-cancel').disabled=false;
}
function activeMode(){const p=importCatalog?.properties.find(p=>p.uuid===$('import-active').value);$('import-active-mode').value=p&&/\binactive\b/i.test(p.title+' '+p.kind)?'zero':'positive';}
function fillImportProperties(){
  const grid=importCatalog.grids.find(g=>g.uuid===$('import-grid').value);if(!grid)return;
  const props=importCatalog.properties.filter(p=>p.support===grid.uuid),guesses={phi:/porosity|poro\b|孔隙|^phi$/i,so:/oil saturation|\bso\b|\bsoil\b|含油/i,k:/permeability|\bperm\b|渗透/i,active:/\bactive\b|\binactive\b|actnum|活动/i};
  for(const key of ['phi','so','k','active']){
    const select=$('import-'+key);select.replaceChildren(new Option(key==='active'?'使用几何有效标志':'不加载此属性',''));
    for(const p of props){if(key!=='active'&&p.discrete)continue;select.add(new Option(p.title+(p.uom?' ['+p.uom+']':'')+(p.timeIndex!==''?' · 时间 '+p.timeIndex:'')+' · '+p.uuid.slice(0,8),p.uuid));}
    const matches=props.filter(p=>(key==='active'||!p.discrete)&&guesses[key].test(p.kind+' '+p.title));if(matches.length===1)select.value=matches[0].uuid;
  }
  $('import-phi-unit').value='auto';activeMode();$('import-status').textContent=grid.reason||grid.dims.join(' × ')+' · 选择属性后加载到两侧。';syncImportControls();
}
$('import-grid').addEventListener('change',fillImportProperties);$('import-active').addEventListener('change',activeMode);
function importError(error){if(importPending){const p=importPending;importPending=null;p.reject(error);}else{importBusy=false;$('import-status').textContent=error.message;syncImportControls();}}
$('resqml-files').addEventListener('change',()=>{
  const files=Array.from($('resqml-files').files);if(!files.length)return;
  importWorker?.terminate();importCatalog=null;importBusy=true;$('import-options').hidden=true;syncImportControls();$('import-status').textContent='正在读取 EPC 中的网格和属性…';
  importWorker=new Worker(new URL('./resqml-worker.js',import.meta.url),{type:'module'});
  importWorker.onmessage=({data})=>{
    if(data.type==='catalog'){importCatalog=data.catalog;importBusy=false;$('import-options').hidden=false;$('import-grid').replaceChildren(...importCatalog.grids.map(g=>new Option(g.title+' · '+g.dims.join('×')+(g.reason?' · 暂不支持':''),g.uuid)));fillImportProperties();}
    else if(data.type==='progress')$('import-status').textContent=data.phase+' · '+Math.round(data.fraction*100)+'%';
    else if(data.type==='ready'){const pending=importPending;importPending=null;pending?.resolve(data.volume);}
    else if(data.type==='error')importError(new Error(data.message));
  };
  importWorker.onerror=()=>{importError(new Error('文件读取失败，请重新选择文件或较小的网格。'));importWorker?.terminate();importWorker=null;importCatalog=null;$('import-options').hidden=true;$('resqml-files').value='';syncImportControls();};
  importWorker.postMessage({type:'inspect',files});
});
$('import-cancel').addEventListener('click',()=>{
  importWorker?.terminate();importWorker=null;importCatalog=null;importBusy=false;$('import-options').hidden=true;$('resqml-files').value='';
  const pending=importPending;importPending=null;pending?.reject(new Error('已取消导入。'));$('import-status').textContent='已取消导入。';syncImportControls();
});
$('import-render').addEventListener('click',async()=>{
  if(!session||!importWorker||importBusy||isLoading)return;
  const limits=session.getImportLimits(),selection={grid:$('import-grid').value,phiUnit:$('import-phi-unit').value,activeMode:$('import-active-mode').value};for(const key of ['phi','so','k','active'])selection[key]=$('import-'+key).value;
  importBusy=true;isLoading=true;disableControls(true);
  try{
    const ready=new Promise((resolve,reject)=>importPending={resolve,reject});importWorker.postMessage({type:'load',selection,limits,backend});
    const next=await ready;importWorker.terminate();importWorker=null;importCatalog=null;importBusy=false;isLoading=false;
    $('import-options').hidden=true;$('resqml-files').value='';$('import-dialog').close();await loadModel('resqml',next);
    if(session)$('import-status').textContent='两侧已加载 '+next.source.title+'。'+next.source.warnings.join(' ');
  }catch(error){$('import-status').textContent=error.message;}
  finally{importBusy=false;isLoading=false;disableControls(false);}
});
window.addEventListener('pagehide',()=>{worker?.terminate();importWorker?.terminate();session?.dispose();},{once:true});
window.addEventListener('pageshow',e=>{if(e.persisted)location.reload();});
loadModel(params.get('scale') in EXPLICIT_SCALES?params.get('scale'):'explicit-10m');
