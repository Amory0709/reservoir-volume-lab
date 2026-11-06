import {CORNERS,FACES,EDGES} from './explicit-grid.js';
const table=(name,type,rows)=>`const ${name}=array<${type},${rows.length}>(${rows.map(row=>`${type}(${row.join(',')})`).join(',')});`;
// All uniform fields occupy 16 bytes, shared with the TypeGPU buffer schema.
export const webgpuUniformFields=['eye','forward','right','up','boundsMin','boundsMax','dimensions','splits','counts','flags','display','style','propertyRange','tile'];
const aliases={uEye:'p.eye.xyz',uTanFov:'p.eye.w',uForward:'p.forward.xyz',uDensity:'p.forward.w',uRight:'p.right.xyz',uEdgeWidth:'p.right.w',uUp:'p.up.xyz',uPixelRatio:'p.up.w',uBoundsMin:'p.boundsMin.xyz',uClipPosition:'p.boundsMin.w',uBoundsMax:'p.boundsMax.xyz',uSurfaceOpacity:'p.boundsMax.w',uDimensions:'vec3i(p.dimensions.xyz)',uNodeWidth:'i32(p.dimensions.w)',uSplits:'p.splits.xyz',uImported:'p.splits.w',uNodeCount:'p.counts.x',uCellCount:'p.counts.y',uNoMatches:'p.counts.z',uSurfacePreview:'p.counts.w',uProperty:'p.flags.x',uPorosityFilter:'p.flags.y',uEdges:'p.flags.z',uInterior:'p.flags.w',uResolution:'p.display.xy',uPhi:'p.display.zw',uClipAxis:'i32(p.style.x)',uLightMode:'p.style.y',uPropertyLog:'p.style.z',uSkipBricks:'p.style.w',uPropertyRange:'p.propertyRange.xy'};
const resolve=source=>source.replace(/\bu[A-Z]\w*/g,name=>aliases[name]??name);
const header=`
struct Frame { ${webgpuUniformFields.map(name=>`${name}: ${['dimensions','counts','flags','style','tile'].includes(name)?'vec4u':name==='splits'?'vec4i':'vec4f'},`).join('\n')} }
@group(0) @binding(0) var<uniform> p: Frame;
@group(0) @binding(1) var uVertices: texture_3d<f32>;
@group(0) @binding(2) var uAttributes: texture_3d<f32>;
@group(0) @binding(3) var uNodes: texture_2d<f32>;
@group(0) @binding(4) var uRanges: texture_2d<f32>;
@group(0) @binding(5) var uColumnPillars: texture_2d<u32>;
@group(0) @binding(6) var uKInterfaces: texture_2d<u32>;
const INF=1e25; const EPS=1.5e-6;
${table('CORNERS','vec3i',CORNERS)}
${table('TRIANGLES','vec3i',FACES)}
${table('EDGES','vec2i',EDGES)}
${table('NEIGHBORS','vec3i',[[0,0,-1],[0,0,1],[0,-1,0],[0,1,0],[-1,0,0],[1,0,0]])}
var<private> v: array<vec3f,8>;
var<private> winding: f32;
var<private> rayVertex: array<vec3f,8>;
var<private> rayDirectionZ:f32;
fn ramp(x:f32)->vec3f{
 let colors=array<vec3f,6>(vec3f(.137,.310,.678),vec3f(.153,.549,.706),vec3f(.322,.776,.627),vec3f(.878,.867,.412),vec3f(.976,.608,.275),vec3f(.827,.231,.208));
 let t=clamp(x,0.0,.99999)*5.0;let i=u32(t);return mix(colors[i],colors[i+1],fract(t));
}
fn ray(pixel:vec2f)->vec3f{
 let xy=(vec2f(pixel.x,uResolution.y-pixel.y)*2.0-uResolution)/uResolution.y;
 return normalize(uForward+uTanFov*(xy.x*uRight+xy.y*uUp));
}
fn background(ro:vec3f,rd:vec3f,pixel:vec2f)->vec3f{
 let uv=vec2f(pixel.x,uResolution.y-pixel.y)/uResolution;
 let q=(uv-vec2f(.5,.48))*vec2f(1.1,1.0);let halo=exp(-3.2*dot(q,q));
 var bg=mix(vec3f(.035,.054,.074),vec3f(.075,.112,.145),halo);
 if(uLightMode==1u){bg=mix(vec3f(.87,.90,.93),vec3f(.98,.985,.99),halo);}
 if(rd.z < -.0001){
  let t=(uBoundsMin.z-.25-ro.z)/rd.z;let point=(ro+rd*t).xy;
  let fade=exp(-.045*dot(point,point));let size=max(.001,2.0*t*uTanFov/uResolution.y);
  let grid=abs(fract(point+.5)-.5);let line=1.0-smoothstep(size*.22,size*.9,min(grid.x,grid.y));
  let color=select(vec3f(.15,.205,.246),vec3f(.56,.64,.69),uLightMode==1u);
  bg=mix(bg,color,line*fade*.3);let shadow=exp(-.17*point.x*point.x-.36*point.y*point.y);
  bg*=1.0-select(.17,.075,uLightMode==1u)*shadow;
 }
 return bg;
}
fn node(index:i32)->vec4f{return textureLoad(uNodes,vec2i(index%uNodeWidth,index/uNodeWidth),0);}
fn rangeAt(id:i32)->vec2f{return textureLoad(uRanges,vec2i(id%uNodeWidth,id/uNodeWidth),0).rg;}
fn matches(value:vec4f)->bool{return value.a>.5&&(uPorosityFilter==0u||(value.g>=uPhi.x&&value.g<=uPhi.y));}
fn valid(cell:vec3i)->bool{return all(cell>=vec3i(0))&&all(cell<uDimensions);}
fn blockX(i:i32)->i32{return select(0,1,i>=uSplits.x)+select(0,1,i>=uSplits.y)+select(0,1,i>=uSplits.z);}
fn pointAt(cell:vec3i,corner:i32)->vec3f{
 if(uImported==1){
  let pillars=textureLoad(uColumnPillars,cell.xy,0);let layers=textureLoad(uKInterfaces,vec2i(cell.z,0),0).rg;
  let pillar=i32(pillars[corner%4]);let width=i32(textureDimensions(uVertices).x);
  return textureLoad(uVertices,vec3i(pillar%width,pillar/width,i32(layers[corner/4])),0).xyz;
 }
 let n=cell+vec3i(blockX(cell.x),select(0,1,cell.y>=uDimensions.y/2),0);
 return textureLoad(uVertices,n+CORNERS[corner],0).xyz;
}
fn corners(cell:vec3i){
 winding=1.0;
 if(uImported==1){winding=select(1.0,-1.0,textureLoad(uAttributes,cell,0).a>1.5);}
 for(var i=0;i<8;i++){v[i]=pointAt(cell,i);}
}
fn propertyColor(value:vec4f)->vec3f{
 if(uImported==0){
  var scalar=(value.r-.05)/.80;
  if(uProperty==1u){scalar=(value.g-.08)/.24;}else if(uProperty==2u){scalar=log(value.b/.5)/log(3000.0);}
  return ramp(scalar);
 }
 var raw=value[uProperty];if((bitcast<u32>(raw)&0x7f800000u)==0x7f800000u){return vec3f(.38,.50,.56);}
 var limits=uPropertyRange;
 if(uPropertyLog==1u){if(raw<=0.0){return vec3f(.38,.50,.56);}raw=log(raw);limits=log(max(limits,vec2f(1e-30)));}
 if(limits.y>limits.x){return ramp((raw-limits.x)/(limits.y-limits.x));}return ramp(.5);
}
struct TriangleHit { valid:bool, t:f32, normal:vec3f }
fn projectCell(ro:vec3f,rd:vec3f)->bool{
 let ad=abs(rd);var kz=2;if(ad.x>ad.y){if(ad.x>ad.z){kz=0;}}else if(ad.y>ad.z){kz=1;}
 let kx=(kz+1)%3;let ky=(kx+1)%3;rayDirectionZ=rd[kz];let shear=vec2f(rd[kx],rd[ky])/rayDirectionZ;
 var lo=vec2f(INF);var hi=vec2f(-INF);
 ${CORNERS.map((_,i)=>`{
  const i=${i};
  let a=v[i]-ro;let projected=vec2f(a[kx],a[ky])-shear*a[kz];
  rayVertex[i]=vec3f(projected,a[kz]);lo=min(lo,projected);hi=max(hi,projected);
 }`).join('\n')}
 return all(lo<=vec2f(0))&&all(hi>=vec2f(0));
}
fn triangle(ro:vec3f,rd:vec3f,index:i32)->TriangleHit{
 let tri=TRIANGLES[index];let a=rayVertex[tri.x];let b=rayVertex[tri.y];let c=rayVertex[tri.z];
 let pa=a.xy;let pb=b.xy;let pc=c.xy;
 let u=pc.x*pb.y-pc.y*pb.x;let w=pb.x*pa.y-pb.y*pa.x;let q=pa.x*pc.y-pa.y*pc.x;
 if(min(u,min(w,q))<0.0&&max(u,max(w,q))>0.0){return TriangleHit(false,0.0,vec3f(0));}
 let determinant=u+w+q;if(determinant==0.0){return TriangleHit(false,0.0,vec3f(0));}
 let t=(u*a.z+q*b.z+w*c.z)/(determinant*rayDirectionZ);
 return TriangleHit(true,t,winding*cross(v[tri.y]-v[tri.x],v[tri.z]-v[tri.x]));
}
struct Hit { found:bool, cell:vec3i, a:f32, b:f32, normal:vec3f, face:i32 }
fn cellInterval(cell:vec3i,ro:vec3f,rd:vec3f,lower:f32,upper:f32)->Hit{
 corners(cell);if(!projectCell(ro,rd)){return Hit(false,cell,INF,INF,vec3f(0),-1);}
 var entries:array<f32,12>;var front=-INF;var back=INF;var bf=-1;var entry=-1;
 ${FACES.map((_,i)=>`{
  const i=${i};entries[i]=-INF;let hit=triangle(ro,rd,i);
  if(hit.valid){if(dot(hit.normal,rd)<0.0){entries[i]=hit.t;}else if(hit.t>=lower-EPS&&hit.t<back){back=hit.t;bf=i/2;}}
 }`).join('\n')}
 ${FACES.map((_,i)=>`if(entries[${i}]<=back&&entries[${i}]>front){front=entries[${i}];entry=${i};}`).join('\n')}
 var hit=Hit(false,cell,INF,INF,vec3f(0),-1);
 if(entry<0||back>=INF){return hit;}
 let tri=TRIANGLES[entry];hit.normal=normalize(winding*cross(v[tri.y]-v[tri.x],v[tri.z]-v[tri.x]));
 hit.a=max(lower,front);hit.b=min(back,upper);hit.face=select(bf,-1,back>upper);
 hit.found=hit.a<INF&&hit.b>hit.a+EPS&&back<INF;return hit;
}
fn nodeNear(id:i32,ro:vec3f,inv:vec3f,lower:f32,upper:f32)->f32{
 let limits=rangeAt(id);if(limits.x>limits.y||(uSkipBricks==1u&&uPorosityFilter==1u&&(limits.y<uPhi.x||limits.x>uPhi.y))){return INF;}
 let t0=(node(id*2).xyz-ro)*inv;let t1=(node(id*2+1).xyz-ro)*inv;let lo=min(t0,t1);let hi=max(t0,t1);
 let a=max(lower,max(lo.x,max(lo.y,lo.z)));let b=min(upper,min(hi.x,min(hi.y,hi.z)));return select(INF,a,b>=a-EPS);
}
fn findCell(ro:vec3f,rd:vec3f,inv:vec3f,lower:f32,upper:f32)->Hit{
 var stack:array<i32,32>;var top=1;stack[0]=0;var hit=Hit(false,vec3i(0),INF,INF,vec3f(0),-1);
 for(var visit=0u;visit<uNodeCount;visit++){
  if(top==0){break;}top--;let id=stack[top];if(nodeNear(id,ro,inv,lower,min(upper,hit.a))>=INF){continue;}
  let hi=node(id*2+1);let leaf=i32(hi.w)-1;
  if(leaf>=0){
   let g=(uDimensions+vec3i(1))/2;let cell=vec3i(leaf%g.x,(leaf/g.x)%g.y,leaf/(g.x*g.y))*2;
   for(var i=0;i<8;i++){
    let candidate=cell+vec3i(i&1,(i>>1)&1,(i>>2)&1);if(!valid(candidate)){continue;}
    if(!matches(textureLoad(uAttributes,candidate,0))){continue;}
    let next=cellInterval(candidate,ro,rd,lower,upper);if(next.found&&next.a<hit.a){hit=next;}
   }
  }else{
   let left=id+1;let right=i32(node(left*2).w);let ta=nodeNear(left,ro,inv,lower,min(upper,hit.a));let tb=nodeNear(right,ro,inv,lower,min(upper,hit.a));
   if(ta<tb){if(tb<INF){stack[top]=right;top++;}if(ta<INF){stack[top]=left;top++;}}
   else{if(ta<INF){stack[top]=left;top++;}if(tb<INF){stack[top]=right;top++;}}
  }
 }
 return hit;
}
fn segmentDistanceSquared(point:vec3f,a:vec3f,b:vec3f)->f32{let delta=b-a;let q=point-a-delta*clamp(dot(point-a,delta)/max(dot(delta,delta),1e-20),0.0,1.0);return dot(q,q);}
fn gridDistance(point:vec3f,section:bool)->f32{
 var distance=INF;
 if(!section){${EDGES.map(([a,b])=>`distance=min(distance,segmentDistanceSquared(point,v[${a}],v[${b}]));`).join('\n')}}
 else{
  let axis=uClipAxis-1;
  for(var i=0;i<12;i++){
   let tri=TRIANGLES[i];var points:array<vec3f,3>;var count=0;
   for(var j=0;j<3;j++){
    let a=v[tri[j]];let b=v[tri[(j+1)%3]];let da=a[axis]-uClipPosition;let db=b[axis]-uClipPosition;
    if((da<=0.0&&db>0.0)||(db<=0.0&&da>0.0)){points[count]=mix(a,b,da/(da-db));count++;}
   }
   if(count==2){distance=min(distance,segmentDistanceSquared(point,points[0],points[1]));}
  }
 }
 return sqrt(distance);
}
fn composite(acc:vec4f,color:vec3f,alpha:f32)->vec4f{let weight=(1.0-acc.a)*clamp(alpha,0.0,1.0);return acc+vec4f(weight*color,weight);}
fn gridLine(acc:vec4f,point:vec3f,t:f32,interior:bool,section:bool)->vec4f{
 let pixel=max(1e-7,2.0*uTanFov*t/uResolution.y);var size=INF;
 ${EDGES.map(([a,b])=>`{let edge=v[${a}]-v[${b}];size=min(size,dot(edge,edge));}`).join('\n')}
 let width=min(uEdgeWidth*uPixelRatio*pixel,sqrt(size)*.19);let distance=gridDistance(point,section);
 let coverage=(1.0-smoothstep(width*.2,width+pixel*.65,distance))*min(1.0,width/(pixel*.55));let transparent=1.0-smoothstep(.4,5.0,uDensity);
 let color=mix(vec3f(.028,.045,.058),vec3f(.39,.60,.64),transparent*select(.42,1.0,interior));
 return composite(acc,color,coverage*select(.88,mix(.16,.62,1.0-transparent),interior));
}
fn connected(cell:vec3i,next:vec3i)->bool{
 if(!valid(next)){return false;}
 if(uImported==0){return blockX(cell.x)==blockX(next.x)&&(cell.y>=uDimensions.y/2)==(next.y>=uDimensions.y/2);}
 if(cell.z!=next.z){let lo=min(cell.z,next.z);return textureLoad(uKInterfaces,vec2i(lo,0),0).g==textureLoad(uKInterfaces,vec2i(lo+1,0),0).r;}
 let a=textureLoad(uColumnPillars,cell.xy,0);let b=textureLoad(uColumnPillars,next.xy,0);
 if(next.x>cell.x){return a.y==b.x&&a.z==b.w;}if(next.x<cell.x){return a.x==b.y&&a.w==b.z;}
 if(next.y>cell.y){return a.w==b.x&&a.z==b.y;}return a.x==b.w&&a.y==b.z;
}
fn volume(pixel:vec2f)->vec4f{
 let rd=ray(pixel);let ro=uEye;let inv=select(vec3f(-1),vec3f(1),rd>=vec3f(0))/max(abs(rd),vec3f(1e-12));
 let bg=background(ro,rd,pixel);var clipNear=0.0;var clipFar=INF;
 if(uClipAxis>0){
  let axis=uClipAxis-1;
  if(abs(rd[axis])<1e-10){if(ro[axis]>uClipPosition){return vec4f(bg,1);}}
  else{let t=(uClipPosition-ro[axis])/rd[axis];if(rd[axis]<0.0){clipNear=max(0.0,t);}else{clipFar=t;}}
 }
 if(clipFar<=clipNear||uNoMatches==1u){return vec4f(bg,1);}
 var acc=vec4f(0);var hit=findCell(ro,rd,inv,clipNear,clipFar);var continuous=false;var cornersReady=false;
 if(uSurfacePreview==1u||uDensity>=28.0){
  if(hit.found){
   corners(hit.cell);let value=textureLoad(uAttributes,hit.cell,0);let section=uClipAxis>0&&clipNear>0.0&&abs(hit.a-clipNear)<EPS*3.0;
   if(section){hit.normal=vec3f(0);hit.normal[uClipAxis-1]=1.0;}
   if(uEdges==1u){acc=gridLine(acc,ro+rd*hit.a,hit.a,false,section);}
   acc=composite(acc,propertyColor(value)*(.78+.22*abs(dot(hit.normal,normalize(vec3f(.4,-.6,.8))))),1.0);
  }
  return vec4f(acc.rgb+(1.0-acc.a)*bg,1);
 }
 for(var step=0u;step<uCellCount*6u;step++){
  if(!hit.found||acc.a>.997){break;}
  if(!cornersReady){corners(hit.cell);}cornersReady=false;
  let value=textureLoad(uAttributes,hit.cell,0);let keep=matches(value);
  var next=hit.cell;var neighbor=false;var nextVisible=false;
  if(hit.face>=0){next+=NEIGHBORS[hit.face];neighbor=connected(hit.cell,next);if(neighbor){nextVisible=matches(textureLoad(uAttributes,next,0));}}
  if(keep){
   let section=uClipAxis>0&&clipNear>0.0&&abs(hit.a-clipNear)<EPS*3.0;
   if(section){hit.normal=vec3f(0);hit.normal[uClipAxis-1]=1.0;}
   if(uEdges==1u&&(!continuous||uInterior==1u)){acc=gridLine(acc,ro+rd*hit.a,hit.a,continuous&&!section,section);}
   let light=.78+.22*abs(dot(hit.normal,normalize(vec3f(.4,-.6,.8))));acc=composite(acc,propertyColor(value)*light,1.0-exp(-uDensity*(hit.b-hit.a)));
   if(uEdges==1u&&!nextVisible){let cut=uClipAxis>0&&abs(hit.b-clipFar)<EPS*3.0;acc=gridLine(acc,ro+rd*hit.b,hit.b,false,cut);}
  }
  // No next-cell or BVH query is needed after opacity reaches the cutoff.
  if(acc.a>.997||hit.b>=clipFar-EPS){break;}let end=hit.b;continuous=false;
  if(neighbor){let adjacent=cellInterval(next,ro,rd,end+EPS,clipFar);if(adjacent.found&&adjacent.a<=end+EPS*3.0){hit=adjacent;hit.a=end;continuous=keep&&nextVisible;cornersReady=true;continue;}}
  hit=findCell(ro,rd,inv,end+EPS*2.0,clipFar);
 }
 return vec4f(acc.rgb+(1.0-acc.a)*bg,1);
}
`;

export const webgpuComputeShader=resolve(header+`
@group(1) @binding(0) var output: texture_storage_2d<rgba8unorm,write>;
@compute @workgroup_size(8,8) fn computeMain(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=p.tile.z||id.y>=p.tile.w){return;}let pixel=id.xy+p.tile.xy;
 if(any(pixel>=vec2u(uResolution))){return;}
 textureStore(output,vec2i(pixel),volume(vec2f(pixel)+.5));
}
`);

const fullscreen=`
struct Fullscreen { @builtin(position) position:vec4f, @location(0) uv:vec2f }
@vertex fn fullscreen(@builtin(vertex_index) i:u32)->Fullscreen{
 let point=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i];
 return Fullscreen(vec4f(point,0,1),point*vec2f(.5,-.5)+.5);
}
`;
export const webgpuSurfaceShader=resolve(header+fullscreen+`
struct SurfaceVertex { @builtin(position) position:vec4f, @location(0) @interpolate(flat) cell:u32, @location(1) @interpolate(flat) section:u32, @location(2) world:vec3f }
fn surfaceVertex(code:u32,index:u32,packed:bool)->SurfaceVertex{
 var cellId=code/8u;var face=i32(code%8u);let vertex=i32(index%6u);
 if(packed){cellId=code>>6u;let mask=code&63u;var ordinal=i32(index/6u);face=0;
  for(var f=0;f<6;f++){if((mask&(1u<<u32(f)))!=0u){if(ordinal==0){face=f;break;}ordinal--;}}
 }
 let cell=vec3i(i32(cellId)%uDimensions.x,(i32(cellId)/uDimensions.x)%uDimensions.y,i32(cellId)/(uDimensions.x*uDimensions.y));
 var world=vec3f(0);
 if(face<6){world=pointAt(cell,TRIANGLES[face*2+vertex/3][vertex%3]);}
 else{
  var lo=vec3f(INF);var hi=vec3f(-INF);for(var i=0;i<8;i++){let point=pointAt(cell,i);lo=min(lo,point);hi=max(hi,point);}
  let a=uClipAxis-1;if(a<0){return SurfaceVertex(vec4f(2,2,2,1),cellId,1u,world);}
  if(lo[a]>uClipPosition||hi[a]<uClipPosition){return SurfaceVertex(vec4f(2,2,2,1),cellId,1u,world);}
  let b=(a+1)%3;let c=(a+2)%3;let q=array<vec2i,6>(vec2i(0,0),vec2i(1,0),vec2i(1,1),vec2i(0,0),vec2i(1,1),vec2i(0,1))[vertex];
  world=lo;world[a]=uClipPosition;world[b]=select(lo[b],hi[b],q.x!=0);world[c]=select(lo[c],hi[c],q.y!=0);
 }
 let point=world-uEye;let z=dot(point,uForward);
 return SurfaceVertex(vec4f(dot(point,uRight)/(uTanFov*uResolution.x/uResolution.y),dot(point,uUp)/uTanFov,.0001,z),cellId,select(0u,1u,face==6),world);
}
@vertex fn packedVertex(@location(0) code:u32,@builtin(vertex_index) index:u32)->SurfaceVertex{return surfaceVertex(code,index,true);}
@vertex fn capVertex(@location(0) code:u32,@builtin(vertex_index) index:u32)->SurfaceVertex{return surfaceVertex(code,index,false);}
struct SurfaceColor { color:vec3f, edgeAlpha:f32, distance:f32 }
fn surfaceColor(input:SurfaceVertex)->SurfaceColor{
 var normal=normalize(cross(dpdx(input.world),dpdy(input.world)));
 let cell=vec3i(i32(input.cell)%uDimensions.x,(i32(input.cell)/uDimensions.x)%uDimensions.y,i32(input.cell)/(uDimensions.x*uDimensions.y));
 let value=textureLoad(uAttributes,cell,0);if(!matches(value)){discard;}
 if(uClipAxis>0&&input.section==0u){if(input.world[uClipAxis-1]>uClipPosition){discard;}}
 let delta=input.world-uEye;let distance=length(delta);let rd=delta/max(distance,1e-12);
 if(input.section==1u){let hit=cellInterval(cell,uEye,rd,distance,INF);if(!hit.found||hit.a>distance+EPS*2.0){discard;}normal=vec3f(0);normal[uClipAxis-1]=1.0;}
 else if(uEdges==1u){corners(cell);}
 var acc=vec4f(0);if(uEdges==1u){acc=gridLine(acc,input.world,distance,false,input.section==1u);}
 let edgeAlpha=acc.a;acc=composite(acc,propertyColor(value)*(.78+.22*abs(dot(normal,normalize(vec3f(.4,-.6,.8))))),1.0);
 return SurfaceColor(acc.rgb,edgeAlpha,distance);
}
@fragment fn opaqueFragment(input:SurfaceVertex)->@location(0) vec4f{return vec4f(surfaceColor(input).color,1);}
struct Accumulation { @location(0) color:vec4f, @location(1) depth:vec4f }
@fragment fn transparentFragment(input:SurfaceVertex)->Accumulation{
 let sample=surfaceColor(input);let alpha=clamp(uSurfaceOpacity+(1.0-uSurfaceOpacity)*sample.edgeAlpha,0.0,.9999);let weight=clamp(1.0/(.01+sample.distance*sample.distance),.01,1.0);
 return Accumulation(vec4f(sample.color*alpha*weight,alpha*weight),vec4f(-log(max(1.0-alpha,1e-4)),0,0,0));
}
@fragment fn backgroundFragment(input:Fullscreen)->@location(0) vec4f{return vec4f(background(uEye,ray(input.position.xy),input.position.xy),1);}
@group(1) @binding(0) var accumulation: texture_2d<f32>;
@group(1) @binding(1) var opticalDepth: texture_2d<f32>;
@fragment fn resolveFragment(input:Fullscreen)->@location(0) vec4f{
 let pixel=vec2i(input.position.xy);let sum=textureLoad(accumulation,pixel,0);let transmission=exp(-min(textureLoad(opticalDepth,pixel,0).r,80.0));
 let bg=background(uEye,ray(input.position.xy),input.position.xy);return vec4f(mix(sum.rgb/max(sum.a,1e-6),bg,transmission),1);
}
`);
export const webgpuPresentShader=fullscreen+`
@group(0) @binding(0) var image: texture_2d<f32>;
@group(0) @binding(1) var imageSampler:sampler;
@fragment fn presentFragment(input:Fullscreen)->@location(0) vec4f{return textureSampleLevel(image,imageSampler,input.uv,0);}
`;
