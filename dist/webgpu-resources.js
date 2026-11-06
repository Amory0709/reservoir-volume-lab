// Shared descriptors keep the browser pipelines and the native WGSL checks aligned.
export function gridTextureSources(v){return [
  {key:'vertices',dimension:'3d',size:v.nodeDims,format:'rgba32float',bytes:16,data:v.vertices},
  {key:'attributes',dimension:'3d',size:v.dims,format:'rgba32float',bytes:16,data:v.attributes},
  {key:'nodes',dimension:'2d',size:[v.nodeWidth,v.nodeHeight],format:'rgba32float',bytes:16,data:v.nodes},
  {key:'ranges',dimension:'2d',size:[v.nodeWidth,v.rangeHeight],format:'rg32float',bytes:8,data:v.ranges},
  {key:'columnPillars',dimension:'2d',size:v.columnPillars?v.dims.slice(0,2):[1,1],format:'rgba32uint',bytes:16,data:v.columnPillars??new Uint32Array(4)},
  {key:'kInterfaces',dimension:'2d',size:v.kInterfaces?[v.dims[2],1]:[1,1],format:'rg32uint',bytes:8,data:v.kInterfaces??new Uint32Array(2)}
];}
export function gridLayoutEntries(){return [
  {binding:0,visibility:7,buffer:{type:'uniform',minBindingSize:224}},
  ...['3d','3d','2d','2d','2d','2d'].map((viewDimension,i)=>({binding:i+1,visibility:7,texture:{sampleType:i<4?'unfilterable-float':'uint',viewDimension}}))
];}
export function frameValues(v,s,basis,size,pixelRatio,noMatches,preview=false,tile=[0,0,size.width,size.height]){
  const a=Math.max(0,s.clipAxis-1),p=v.propertyInfo?.[s.property]??{min:0,max:1,log:false};
  return {
    eye:[...basis.eye,Math.tan(21*Math.PI/180)],forward:[...basis.forward,28*(s.density/100)**2],
    right:[...basis.right,s.lineWidth],up:[...basis.up,pixelRatio],
    boundsMin:[...v.bounds.min,v.bounds.max[a]-(v.bounds.max[a]-v.bounds.min[a])*s.clip/100],
    boundsMax:[...v.bounds.max,!s.surfaceOnly&&s.density>=100?1:1-(s.surfaceTransparency??0)/100],
    dimensions:[...v.dims,v.nodeWidth],splits:[...v.splitsX,v.synthetic===false?1:0],
    counts:[v.nodeCount,v.stats.cells,noMatches?1:0,preview?1:0],
    flags:[s.property,+s.porosityFilter,+s.edges,+s.interior],
    display:[size.width,size.height,s.porosityMin/100,s.porosityMax/100],
    style:[s.clipAxis,+s.lightMode,+p.log,1],propertyRange:[p.min,p.max,0,0],tile
  };
}
