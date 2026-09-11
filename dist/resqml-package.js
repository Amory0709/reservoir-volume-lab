import {unzipSync,strFromU8,DOMParser} from './vendor/epc.js';

export const children=(node,name)=>Array.from(node?.childNodes??[]).filter(n=>n.nodeType===1&&(!name||n.localName===name));
export const child=(node,name)=>children(node,name)[0];
export const path=(node,...names)=>names.reduce((n,key)=>child(n,key),node);
export const text=node=>node?.textContent?.trim()??'';
export const value=(node,name)=>text(child(node,name));
export const type=node=>(node?.getAttributeNS('http://www.w3.org/2001/XMLSchema-instance','type')||node?.localName||'').split(':').at(-1).replace(/^obj_/,'');
export const descendants=(node,name)=>Array.from(node?.getElementsByTagName('*')??[]).filter(n=>n.localName===name);
export const uuid=node=>(node?.getAttribute('uuid')||value(node,'UUID')).toLowerCase();
export function integer(node,name,minimum=0){const s=value(node,name),n=Number(s);if(!s||!Number.isSafeInteger(n)||n<minimum)throw new Error('无效的 '+name+'。');return n;}
export function parseXml(source,name){
  if(/<!DOCTYPE|<!ENTITY/i.test(source))throw new Error(name+' 包含不支持的 XML 实体声明。');
  let invalid=false;
  const doc=new DOMParser({onError:()=>{invalid=true;}}).parseFromString(source,'application/xml');
  if(invalid||!doc?.documentElement)throw new Error(name+' 的 XML 无法解析。');
  return doc.documentElement;
}
const title=root=>text(path(root,'Citation','Title'))||root.localName;
const base=name=>name.replaceAll('\\','/').split('/').at(-1).toLowerCase();
export function inspectEpc(bytes,files=[]){
  let xmlBytes=0;
  const entries=unzipSync(bytes,{filter:file=>{
    if(!/\.(xml|rels)$/i.test(file.name))return false;
    xmlBytes+=file.originalSize;
    if(file.originalSize>32*1024*1024||xmlBytes>128*1024*1024)throw new Error('EPC 中的 XML 过大，请按模型拆分导出。');
    return true;
  }});
  const objects=new Map(),byName=new Map(),proxies=new Map();
  for(const [name,data]of Object.entries(entries)){
    const root=parseXml(strFromU8(data),name);byName.set(name,root);
    const id=uuid(root);if(id){if(objects.has(id))throw new Error('EPC 中有重复对象 UUID：'+id);objects.set(id,{root,name});}
  }
  for(const [id,{root,name}]of objects){
    if(type(root)!=='EpcExternalPartReference')continue;
    const slash=name.lastIndexOf('/'),rels=name.slice(0,slash+1)+'_rels/'+name.slice(slash+1)+'.rels';
    const refs=children(byName.get(rels),'Relationship').filter(n=>/externalResource$/i.test(n.getAttribute('Type')));
    if(refs.length!==1)continue;
    let target=refs[0].getAttribute('Target');try{target=decodeURIComponent(target);}catch{}
    proxies.set(id,target);
  }
  const grids=[],properties=[];
  for(const [id,{root}]of objects){
    const kind=type(root);
    if(kind==='IjkGridRepresentation'){
      const dims=['Ni','Nj','Nk'].map(n=>integer(root,n,1)),points=path(root,'Geometry','Points');
      const version=root.getAttribute('schemaVersion')||'';
      let reason='';
      if(version&&!/^2\.0(?:\.|$)/.test(version))reason='当前支持 RESQML 2.0 / 2.0.1，请导出为该版本。';
      else if(!['Point3dHdf5Array','Point3dParametricArray','Point3dLatticeArray'].includes(type(points)))reason='暂不支持几何类型 '+(type(points)||'缺失 Geometry')+'。';
      else if(descendants(root,'TruncationCells').length||descendants(root,'AdditionalGridPoints').length)reason='暂不支持截断网格或附加网格点。';
      else if(dims.reduce((a,b)=>a*b,1)>20000000)reason='当前导入上限为 20,000,000 个单元，请先导出子模型。';
      grids.push({uuid:id,title:title(root),dims,geometry:type(points),version,reason});
    }else if(['ContinuousProperty','DiscreteProperty'].includes(kind)){
      const support=uuid(child(root,'SupportingRepresentation')),patches=children(root,'PatchOfValues');
      if(value(root,'IndexableElement')!=='cells'||integer(root,'Count',1)!==1||patches.length!==1)continue;
      const pk=child(root,'PropertyKind'),local=objects.get(uuid(child(pk,'LocalPropertyKind')))?.root;
      const propertyKind=value(pk,'Kind')||(local?title(local):text(path(pk,'LocalPropertyKind','Title')));
      const timeIndex=text(path(root,'TimeIndex','Index'));
      properties.push({uuid:id,title:title(root),support,kind:propertyKind,uom:value(root,'UOM')||value(root,'Uom'),discrete:kind==='DiscreteProperty',timeIndex,values:child(patches[0],'Values')});
    }
  }
  if(!grids.length)throw new Error('EPC 中未找到 IjkGridRepresentation。当前支持 IJK 六面体网格，暂不支持任意非结构多面体网格。');
  function fileForProxy(id){
    const target=proxies.get(id.toLowerCase());
    if(!target)throw new Error('EPC 缺少 HDF5 外部文件关联：'+id+'。请重新导出完整 EPC。');
    const candidates=files.filter(f=>base(f.name)===base(target));
    if(candidates.length!==1)throw new Error(candidates.length?'HDF5 文件名重复，无法确定：'+target:'缺少 HDF5 文件：'+target+'。请将 EPC 与此文件一起选择。');
    return candidates[0];
  }
  return {objects,grids,properties,proxies,fileForProxy,catalog:{grids,properties:properties.map(({values,...p})=>p),files:[...proxies.values()]}};
}
