import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import * as h5 from 'h5wasm/node';
import {inspectEpc,child,descendants,parseXml} from './dist/resqml-package.js';
import {importResqmlGrid,arrayReader} from './dist/resqml-import.js';
import {cornerOffset,CORNERS,countExplicitMatches} from './dist/explicit-grid.js';
import {vertexShader,explicitFragmentShader} from './dist/explicit-shaders.js';
const root=resolve(process.argv[2]);await h5.ready;
const expected=JSON.parse(readFileSync(root+'/expected.json')),bytes=new Uint8Array(readFileSync(root+'/reference.epc'));
const files=[{name:'reference.h5'}],pkg=inspectEpc(bytes,files),opened=new Map();
const openFile=file=>{if(!opened.has(file.name))opened.set(file.name,new h5.File(root+'/'+file.name,'r'));return opened.get(file.name);};
assert.equal(pkg.grids.length,3);assert.equal(pkg.properties.length,15); // includes lattice DX/DY/DZ
try{
  for(const item of expected){
    const selection={grid:item.grid,...item.properties,phiUnit:'auto'};
    const v=importResqmlGrid(pkg,selection,openFile,()=>{},{max3d:6,max2d:4096});
    assert.deepEqual(v.dims,item.dims);assert.equal(v.synthetic,false);assert.equal(v.source.splitCount,item.splitCount);assert.equal(v.source.gapCount,item.gapCount);
    assert.equal(v.stats.activeCells,item.active.filter(Boolean).length);assert.equal(v.stats.invalidCells,0);
    const [nx,ny,nz]=v.dims,{centerMetres:center,scale}=v.source.normalization;
    let maxError=0;
    for(let k=0;k<nz;k++)for(let j=0;j<ny;j++)for(let i=0;i<nx;i++){
      const id=(k*ny+j)*nx+i;
      for(let c=0;c<8;c++){
        const [dx,dy,dz]=CORNERS[c],point=item.corners[id][dz][dy][dx],o=cornerOffset(v,i,j,k,c);
        for(let a=0;a<3;a++){const target=(point[a]*.3048*(a===2?-1:1)-center[a])*scale;maxError=Math.max(maxError,Math.abs(v.vertices[o+a]-target));}
      }
    }
    assert(maxError<2e-6,`Wrong corner mapping / units / normalization: ${item.variant}: ${maxError}`);
    for(const [lo,hi]of [[0,100],[4,42],[18,25],[20,20],[40,100]]){
      const reference=item.phi.filter((p,id)=>item.active[id]&&p!==null&&Math.fround(p)>=Math.fround(lo/100)&&Math.fround(p)<=Math.fround(hi/100)).length;
      assert.equal(countExplicitMatches(v,{porosityFilter:true,porosityMin:lo,porosityMax:hi}),reference);
    }
    assert.equal(v.propertyInfo[1].missing,1);assert(v.source.warnings.length);assert(v.attributes[7]>1.5,'Depth inversion winding missing');
    const dir=root+'/'+item.variant;mkdirSync(dir,{recursive:true});
    const keys=['dims','nodeDims','splitsX','bounds','nodeCount','nodeWidth','nodeHeight','rangeHeight','stats','propertyInfo','synthetic'];
    writeFileSync(dir+'/metadata.json',JSON.stringify(Object.fromEntries(keys.map(k=>[k,v[k]]))));
    for(const key of ['vertices','attributes','nodes','ranges','columnPillars','kInterfaces'])writeFileSync(dir+'/'+key+'.bin',new Uint8Array(v[key].buffer));
    writeFileSync(dir+'/vertex.glsl',vertexShader);writeFileSync(dir+'/fragment.glsl',explicitFragmentShader);
    writeFileSync(dir+'/alpha.glsl',explicitFragmentShader.replaceAll('outColor=vec4(acc.rgb+(1.0-acc.a)*bg,1);','outColor=vec4(vec3(acc.a),1);').replaceAll('outColor=vec4(bg,1);','outColor=vec4(0,0,0,1);'));
    console.log('PASS independent RESQML roundtrip',item.variant,{cells:v.stats.cells,active:v.stats.activeCells,split:v.source.splitCount,gaps:v.source.gapCount,maxCornerError:maxError});
  }
  const item=expected[0],selection={grid:item.grid,...item.properties,phiUnit:'auto'};
  assert.throws(()=>importResqmlGrid(inspectEpc(bytes,[]),selection,openFile),/缺少 HDF5/);
  assert.throws(()=>importResqmlGrid(pkg,selection,openFile,()=>{},{max3d:2,max2d:4096}),/纹理限制/);
  assert.throws(()=>importResqmlGrid(pkg,{...selection,phi:expected[1].properties.phi},openFile),/不属于/);
  const geometry=importResqmlGrid(pkg,{grid:item.grid},openFile);assert.equal(geometry.propertyInfo[1].available,false);assert.equal(geometry.sortedPhi.length,0);assert(geometry.stats.activeCells>0);
  const prop=pkg.properties.find(p=>p.uuid===item.properties.phi),oldUnit=prop.uom;prop.uom='unknown';
  assert.throws(()=>importResqmlGrid(pkg,selection,openFile),/单位/);
  assert.equal(importResqmlGrid(pkg,{...selection,phiUnit:'percent'},openFile).stats.activeCells,44);prop.uom=oldUnit;
  const geom=child(pkg.objects.get(item.grid).root,'Geometry'),dataset=descendants(child(geom,'Points'),'PathInHdfFile')[0],original=dataset.textContent;
  dataset.textContent='/missing';assert.throws(()=>importResqmlGrid(pkg,selection,openFile),/数据集/);dataset.textContent=original;
  assert.throws(()=>parseXml('<!DOCTYPE x><x/>','test'),/实体/);
  assert.throws(()=>parseXml('<x><y></x>','test'),/XML|tag|end/i);
  assert.equal(importResqmlGrid(pkg,{...selection,activeMode:'zero'},openFile).stats.activeCells,1);
  console.log('PASS missing HDF5, unsupported units, explicit unit override, wrong-grid properties, GPU size limits, geometry-only import and missing datasets');
}finally{for(const file of opened.values())file.close();}

// A single HDF5 slab can exceed the read budget: subdivide an inner dimension
// while retaining the exact flat I-fastest order and float64 coordinate values.
const streaming=new h5.File(root+'/streaming.h5','w'),shape=[2,300001,3],count=shape.reduce((a,b)=>a*b,1);
try{
  streaming.create_dataset({name:'xyz',data:Float64Array.from({length:count},(_,i)=>i*.125),shape});
  const node=parseXml('<Points xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="Point3dHdf5Array"><Coordinates><PathInHdfFile>/xyz</PathInHdfFile><HdfProxy><UUID>stream</UUID></HdfProxy></Coordinates></Points>','stream');
  const array=arrayReader({fileForProxy:()=>({name:'streaming.h5'})},()=>streaming)(node,count);let covered=0,maxChunk=0;
  array.each((data,offset,convert)=>{assert.equal(offset,covered);assert(data.length<=524286);for(let i=0;i<data.length;i+=1009)assert.equal(convert(data[i]),(offset+i)*.125);covered+=data.length;maxChunk=Math.max(maxChunk,data.length);});
  assert.equal(covered,count);console.log('PASS bounded HDF5 inner-dimension reads',{values:covered,maxChunk});
}finally{streaming.close();}
