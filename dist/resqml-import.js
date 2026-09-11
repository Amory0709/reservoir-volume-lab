import {child,children,path,text,value,type,uuid,integer,descendants} from './resqml-package.js';
import {buildExplicitBvh,cornerOffset,FACES} from './explicit-grid.js';

const product=a=>a.reduce((x,y)=>x*y,1);
const bool=s=>s==='true'||s==='1';
const number=s=>s==='true'?1:s==='false'?0:Number(s);
const units={m:1,ft:.3048,'ft[US]':1200/3937,cm:.01,mm:.001,km:1000};

/** HDF5 backend is injected: WORKERFS in the app, real HDF5 files in Node tests. */
export function arrayReader(pkg,openFile){
  return function read(node,expected){
    if(!node)throw new Error('缺少数组定义。');
    const kind=type(node),nullText=value(node,'NullValue'),nullValue=nullText?number(nullText):NaN;
    const clean=v=>{const n=Number(v);return n===nullValue?NaN:n;};
    let count,shape,each;
    const paths=descendants(node,'PathInHdfFile');
    if(paths.length){
      if(paths.length!==1)throw new Error('暂不支持一个数组跨多个 HDF5 数据集。');
      const ref=paths[0].parentNode,proxy=uuid(child(ref,'HdfProxy')),file=pkg.fileForProxy(proxy),datasetPath=text(paths[0]);
      const dataset=openFile(file).get(datasetPath);
      if(!dataset?.shape||!Array.isArray(dataset.shape))throw new Error('HDF5 数据集不存在或类型不支持：'+file.name+' → '+datasetPath);
      shape=dataset.shape;count=product(shape);
      if(!shape.length||!Number.isSafeInteger(count))throw new Error('不支持的 HDF5 数组形状：'+datasetPath);
      // Bound temporary buffers. No .value read of the entire 10M/20M array.
      let axis=0;while(axis<shape.length-1&&product(shape.slice(axis+1))>524286)axis++;
      const stride=product(shape.slice(axis+1)),rows=Math.max(1,Math.floor(524286/stride)),prefixCount=product(shape.slice(0,axis));
      each=callback=>{
        for(let prefix=0;prefix<prefixCount;prefix++)for(let start=0;start<shape[axis];start+=rows){
          const end=Math.min(shape[axis],start+rows),slice=shape.map(()=>[]);slice[axis]=[start,end];let index=prefix;
          for(let d=axis-1;d>=0;d--){const n=index%shape[d];slice[d]=[n,n+1];index=Math.floor(index/shape[d]);}
          let data;try{data=dataset.slice(slice);}catch(e){throw new Error('无法读取 '+file.name+' → '+datasetPath+'。请检查压缩格式及文件完整性。'+e.message);}
          if(!ArrayBuffer.isView(data)||data.length!==(end-start)*stride)throw new Error('HDF5 数组不是可读取的数值数据：'+datasetPath);
          callback(data,(prefix*shape[axis]+start)*stride,clean);
        }
      };
    }else if(/ConstantArray$/.test(kind)){
      count=integer(node,'Count');const raw=value(node,'Value');if(!raw)throw new Error('常量数组缺少 Value。');const n=number(raw);
      each=callback=>{const block=new Float64Array(Math.min(count,524288));block.fill(n);for(let start=0;start<count;start+=block.length)callback(block.subarray(0,Math.min(block.length,count-start)),start,clean);};
    }else if(/XmlArray$/.test(kind)){
      const raw=value(node,'Values')||value(node,'Value'),data=Float64Array.from(raw.split(/\s+/).filter(Boolean),number);count=data.length;each=callback=>callback(data,0,clean);
    }else throw new Error('暂不支持数组编码 '+kind+'，请使用 HDF5 数组或常量数组导出。');
    if(expected!==undefined&&count!==expected)throw new Error('数组长度不匹配：预期 '+expected+'，实际 '+count+'。');
    return {count,shape,each,all(){const out=new Float64Array(count);each((a,o,convert)=>{for(let i=0;i<a.length;i++)out[o+i]=convert(a[i]);});return out;}};
  };
}

function fractionFactor(unit,override,label){
  if(override==='percent')return .01;if(override==='fraction')return 1;
  if(['%','percent','pct'].includes(unit.toLowerCase()))return .01;
  if(['Euc','m3/m3','m^3/m^3','ft3/ft3','v/v','1','fraction'].includes(unit))return 1;
  throw new Error(label+'单位“'+(unit||'未提供')+'”无法确定。请指定孔隙度为 0–1 小数或 0–100 百分数；饱和度请使用有明确单位的属性。');
}
function checkedIndex(n,count,label){if(!Number.isInteger(n)||n<0||n>=count)throw new Error(label+'索引越界。');return n;}

export function importResqmlGrid(pkg,selection,openFile,progress=()=>{},limits={}){
  const start=performance.now(),grid=pkg.grids.find(g=>g.uuid===selection.grid);
  if(!grid)throw new Error('请选择文件中的网格。');if(grid.reason)throw new Error(grid.reason);
  const root=pkg.objects.get(grid.uuid).root,geom=child(root,'Geometry'),read=arrayReader(pkg,openFile);
  const dims=grid.dims,[nx,ny,nz]=dims,count=product(dims),primary=(nx+1)*(ny+1),columns=nx*ny;
  const splitNode=child(geom,'SplitCoordinateLines'),splitCount=splitNode?integer(splitNode,'Count'):0,pillars=primary+splitCount;
  if(splitCount>columns*4)throw new Error('断层拆点数量不合理。');
  const kgaps=child(root,'KGaps'),gapCount=kgaps?integer(kgaps,'Count'):0;
  if(gapCount>=nz)throw new Error('K 层间隙数量不合理。');
  const levels=nz+gapCount+1,kInterfaces=new Uint32Array(nz*2);
  const gaps=gapCount?read(child(kgaps,'GapAfterLayer'),nz-1).all():null;let rawK=0;
  for(let k=0;k<nz;k++){kInterfaces[k*2]=rawK;kInterfaces[k*2+1]=++rawK;if(gaps&&k<nz-1){if(gaps[k]!==0&&gaps[k]!==1)throw new Error('层间隙标志必须是 0 或 1。');rawK+=gaps[k];}}
  if(rawK+1!==levels)throw new Error('层间隙标志与 KGaps.Count 不一致。');
  const max3d=limits.max3d??2048,max2d=limits.max2d??4096,nodeDims=[Math.min(max3d,pillars),Math.ceil(pillars/Math.min(max3d,pillars)),levels];
  if([...dims,...nodeDims].some(n=>n>max3d)||nx>max2d||ny>max2d||nz>max2d)throw new Error('网格维度超过此显卡的纹理限制，请导出较小的 IJK 子模型。');
  const bvhCount=2*product(dims.map(n=>Math.ceil(n/2)))-1;
  if(bvhCount>=16777216||Math.ceil(bvhCount*2/2048)>max2d)throw new Error('网格空间索引超过此显卡支持的尺寸。');
  const columnPillars=new Uint32Array(columns*4);
  for(let j=0;j<ny;j++)for(let i=0;i<nx;i++){const p=j*(nx+1)+i;columnPillars.set([p,p+1,p+nx+2,p+nx+1],(j*nx+i)*4);}
  let splitParents=new Float64Array(0);
  if(splitCount){
    splitParents=read(child(splitNode,'PillarIndices'),splitCount).all();
    const jag=child(splitNode,'ColumnsPerSplitCoordinateLine'),ends=read(child(jag,'CumulativeLength'),splitCount).all();
    const elements=read(child(jag,'Elements')).all();let previous=0;
    for(let s=0;s<splitCount;s++){
      const p=checkedIndex(splitParents[s],primary,'拆点柱线'),end=ends[s];
      if(!Number.isInteger(end)||end<=previous||end>elements.length)throw new Error('拆点列关联的累计长度无效。');
      for(let e=previous;e<end;e++){
        const col=checkedIndex(elements[e],columns,'拆点单元列');let found=false;
        for(let c=0;c<4;c++)if(columnPillars[col*4+c]===p){columnPillars[col*4+c]=primary+s;found=true;break;}
        if(!found)throw new Error('拆点关联的柱线不属于该列，或关联重复。');
      }
      previous=end;
    }
    if(previous!==elements.length)throw new Error('拆点列关联数据长度不一致。');
  }
  progress(.08,'读取角点和坐标系');
  const crsRoot=pkg.objects.get(uuid(child(geom,'LocalCrs')))?.root;
  if(!crsRoot||type(crsRoot)!=='LocalDepth3dCrs')throw new Error('需要 LocalDepth3dCrs 深度坐标系；时间域网格请先转换为深度域。');
  const xyUnit=value(crsRoot,'ProjectedUom'),zUnit=value(crsRoot,'VerticalUom'),xyFactor=units[xyUnit],zFactor=units[zUnit];
  if(!xyFactor||!zFactor)throw new Error('暂不支持坐标单位 '+xyUnit+' / '+zUnit+'。请导出为米或英尺。');
  const zFlag=value(crsRoot,'ZIncreasingDownward');if(!['true','false','0','1'].includes(zFlag))throw new Error('坐标系缺少有效的 ZIncreasingDownward 深度方向。');
  const zSign=bool(zFlag)?-1:1;
  const crs={uuid:uuid(crsRoot),title:text(path(crsRoot,'Citation','Title')),xyUnit,zUnit,zIncreasingDownward:zSign<0,axisOrder:value(crsRoot,'ProjectedAxisOrder'),offsets:['XOffset','YOffset','ZOffset'].map(n=>Number(value(crsRoot,n)||0)),rotation:value(crsRoot,'ArealRotation'),rotationUnit:child(crsRoot,'ArealRotation')?.getAttribute('uom'),xml:crsRoot.toString(),frame:'local; units converted to metres; positive Z up; no map reprojection'};
  const points=child(geom,'Points'),pointCount=levels*pillars;let eachPoint;
  if(type(points)==='Point3dHdf5Array'){
    const source=read(points,pointCount*3);
    if(source.shape&&source.shape.length>1&&source.shape.at(-1)!==3)throw new Error('XYZ 坐标数组的最后一维必须是 3。');
    eachPoint=callback=>source.each((a,offset,convert)=>{
      if(offset%3||a.length%3)throw new Error('XYZ 坐标数组必须以三分量点存储。');
      for(let n=0;n<a.length;n+=3)callback((offset+n)/3,convert(a[n]),convert(a[n+1]),convert(a[n+2]));
    });
  }else if(type(points)==='Point3dParametricArray'){
    const lines=child(points,'ParametricLines');
    if(child(points,'ParametricLineIndices'))throw new Error('暂不支持额外的参数柱线索引，请导出为显式 XYZ 角点。');
    if(integer(lines,'KnotCount',1)!==2)throw new Error('当前支持两控制点直线柱的参数化网格；曲线柱请导出为显式 XYZ 角点。');
    const kinds=read(child(lines,'LineKindIndices'),primary).all();if(kinds.some(n=>n!==1))throw new Error('当前参数化网格支持 LineKindIndices=1；请导出直线柱或显式 XYZ。');
    const cp=read(child(lines,'ControlPoints'),primary*6).all(),cpp=read(child(lines,'ControlPointParameters'),primary*2).all(),parameters=read(child(points,'Parameters'),pointCount);
    eachPoint=callback=>parameters.each((a,offset,convert)=>{for(let n=0;n<a.length;n++){
      const id=offset+n,p=id%pillars,q=p<primary?p:splitParents[p-primary],denom=cpp[primary+q]-cpp[q],t=(convert(a[n])-cpp[q])/denom;
      const o=q*3,top=(primary+q)*3;
      callback(id,cp[o]+t*(cp[top]-cp[o]),cp[o+1]+t*(cp[top+1]-cp[o+1]),cp[o+2]+t*(cp[top+2]-cp[o+2]));
    }});
  }else{
    if(splitCount)throw new Error('Lattice 网格不能带拆点柱线，请导出显式 XYZ。');
    const xyz=n=>['Coordinate1','Coordinate2','Coordinate3'].map(k=>{const s=value(n,k),v=Number(s);if(!s||!Number.isFinite(v))throw new Error('Lattice 原点或偏移坐标无效。');return v;});
    const origin=xyz(child(points,'Origin')),offsets=children(points,'Offset');
    if(offsets.length!==3)throw new Error('Lattice 网格需要 K、J、I 三个方向的偏移。');
    const vectors=offsets.map(n=>xyz(child(n,'Offset'))),lengths=[levels-1,ny,nx],distances=offsets.map((n,axis)=>{const a=read(child(n,'Spacing'),lengths[axis]).all(),out=new Float64Array(a.length+1);for(let i=0;i<a.length;i++)out[i+1]=out[i]+a[i];return out;});
    eachPoint=callback=>{for(let k=0;k<levels;k++)for(let j=0;j<=ny;j++)for(let i=0;i<=nx;i++){
      const d=[distances[0][k],distances[1][j],distances[2][i]],p=[...origin];for(let axis=0;axis<3;axis++)for(let c=0;c<3;c++)p[c]+=d[axis]*vectors[axis][c];callback((k*(ny+1)+j)*(nx+1)+i,...p);
    }};
  }
  // Two bounded reads preserve double precision until origin subtraction.
  const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
  eachPoint((_,x,y,z)=>{if(!Number.isFinite(x+y+z))return;const p=[x*xyFactor,y*xyFactor,z*zFactor*zSign];for(let c=0;c<3;c++){min[c]=Math.min(min[c],p[c]);max[c]=Math.max(max[c],p[c]);}});
  const span=max.map((n,c)=>n-min[c]),extent=Math.max(...span),center=min.map((n,c)=>n+span[c]/2);
  if(!Number.isFinite(extent)||extent<=0)throw new Error('网格没有有效的空间范围。');
  const scale=6.2/extent,vertices=new Float32Array(product(nodeDims)*4);
  eachPoint((id,x,y,z)=>{const level=Math.floor(id/pillars),p=id%pillars,o=(level*nodeDims[0]*nodeDims[1]+p)*4;vertices[o]=(x*xyFactor-center[0])*scale;vertices[o+1]=(y*xyFactor-center[1])*scale;vertices[o+2]=(z*zFactor*zSign-center[2])*scale;vertices[o+3]=1;});
  progress(.38,'读取活动单元和属性');
  const attributes=new Float32Array(count*4);for(let i=0;i<count;i++){attributes[i*4]=attributes[i*4+1]=attributes[i*4+2]=NaN;attributes[i*4+3]=1;}
  const propertyInfo=[],warnings=[];
  function selected(key){const id=selection[key];if(!id)return null;const prop=pkg.properties.find(p=>p.uuid===id&&p.support===grid.uuid);if(!prop)throw new Error('所选属性不属于当前网格。');return prop;}
  const activeProp=selected('active');
  if(activeProp){const invert=selection.activeMode==='zero';read(activeProp.values,count).each((a,o,convert)=>{for(let n=0;n<a.length;n++){const v=convert(a[n]);attributes[(o+n)*4+3]=Number.isFinite(v)&&(invert?v===0:v>0)?1:0;}});}
  const defined=child(geom,'CellGeometryIsDefined');if(defined)read(defined,count).each((a,o,convert)=>{for(let n=0;n<a.length;n++)if(convert(a[n])!==1)attributes[(o+n)*4+3]=0;});
  const pillarDefined=child(geom,'PillarGeometryIsDefined'),pillarFlags=pillarDefined?read(pillarDefined,primary).all():null;
  for(const [slot,key,label]of [[0,'so','含油饱和度'],[1,'phi','孔隙度'],[2,'k','渗透率']]){
    const prop=selected(key),info={name:label,available:!!prop,title:prop?.title??'',unit:prop?.uom??'',min:Infinity,max:-Infinity,log:false,missing:0};propertyInfo.push(info);
    if(!prop)continue;
    const factor=key==='phi'?fractionFactor(prop.uom,selection.phiUnit,'孔隙度'):key==='so'?fractionFactor(prop.uom,'auto','饱和度'):1;
    read(prop.values,count).each((a,o,convert)=>{for(let n=0;n<a.length;n++){
      const v=convert(a[n])*factor,valid=Number.isFinite(v)&&(slot===2?v>=0:v>=0&&v<=1);attributes[(o+n)*4+slot]=valid?v:NaN;
    }});
    if(key==='phi')info.unit='%';if(key==='so')info.unit='无量纲';
  }
  const v={kind:'explicit',scale:'resqml',synthetic:false,dims:[...dims],nodeDims,splitsX:[nx,nx,nx],splitY:ny,columnPillars,kInterfaces,vertices,attributes,propertyInfo,source:{title:grid.title,uuid:grid.uuid,geometry:grid.geometry,version:grid.version,splitCount,gapCount,crs,normalization:{centerMetres:center,scale},warnings},stats:{cells:count,vertices:pointCount,propertyBytes:attributes.byteLength}};
  const sortedPhi=new Float32Array(count);let active=0,finitePhi=0,invalid=0;const p=new Float64Array(24);
  for(let k=0;k<nz;k++)for(let j=0;j<ny;j++)for(let i=0;i<nx;i++){
    const o=((k*ny+j)*nx+i)*4;if(!attributes[o+3])continue;
    if((o&1048575)===0)progress(.40+.20*o/(count*4),'检查活动单元几何');
    let valid=true;
    for(let c=0;c<8;c++){
      const pos=cornerOffset(v,i,j,k,c);for(let a=0;a<3;a++){const n=vertices[pos+a];p[c*3+a]=n;if(!Number.isFinite(n))valid=false;}
      if(pillarFlags){const pillar=columnPillars[(j*nx+i)*4+c%4],primaryPillar=pillar<primary?pillar:splitParents[pillar-primary];if(pillarFlags[primaryPillar]!==1)valid=false;}
    }
    // Signed surface volume supplies per-cell winding after depth-axis inversion.
    let sixVolume=0;
    for(const [aa,bb,cc]of FACES){
      const a=aa*3,b=bb*3,c=cc*3,ax=p[a]-p[0],ay=p[a+1]-p[1],az=p[a+2]-p[2],bx=p[b]-p[0],by=p[b+1]-p[1],bz=p[b+2]-p[2],cx=p[c]-p[0],cy=p[c+1]-p[1],cz=p[c+2]-p[2];sixVolume+=ax*(by*cz-bz*cy)+ay*(bz*cx-bx*cz)+az*(bx*cy-by*cx);
    }
    if(!valid||!Number.isFinite(sixVolume)||Math.abs(sixVolume)<1e-20){attributes[o+3]=0;invalid++;continue;}
    attributes[o+3]=sixVolume<0?2:1;active++;
    for(let slot=0;slot<3;slot++){const n=attributes[o+slot],info=propertyInfo[slot];if(Number.isFinite(n)){info.min=Math.min(info.min,n);info.max=Math.max(info.max,n);}else if(info.available)info.missing++;}
    if(Number.isFinite(attributes[o+1]))sortedPhi[finitePhi++]=attributes[o+1];
  }
  if(!active)throw new Error('没有可渲染的活动单元，请检查活动属性、几何定义和角点数据。');
  if(invalid)warnings.push(invalid.toLocaleString()+' 个活动单元角点无效或体积退化，已排除。');
  for(const info of propertyInfo){if(!Number.isFinite(info.min)){info.available=false;info.min=0;info.max=1;}if(info.missing)warnings.push(info.name+'有 '+info.missing.toLocaleString()+' 个活动单元缺失或超出有效范围；着色为灰色，孔隙度缺失值不参与筛选。');}
  propertyInfo[2].log=propertyInfo[2].min>0;
  if(!propertyInfo[1].available)warnings.push('未加载有效孔隙度属性，孔隙度筛选已关闭。');
  v.sortedPhi=sortedPhi.subarray(0,finitePhi);v.stats.activeCells=active;v.stats.inactiveCells=count-active;v.stats.invalidCells=invalid;
  progress(.60,'建立真实角点空间索引');buildExplicitBvh(v,f=>progress(.60+.32*f,'建立真实角点空间索引'));
  progress(.94,'建立孔隙度计数索引');v.sortedPhi.sort();v.stats.gpuBytes=vertices.byteLength+attributes.byteLength+v.nodes.byteLength+v.ranges.byteLength+columnPillars.byteLength+kInterfaces.byteLength;
  v.stats.cpuIndexBytes=sortedPhi.byteLength;v.stats.generationMs=performance.now()-start;progress(1,'准备渲染');return v;
}
