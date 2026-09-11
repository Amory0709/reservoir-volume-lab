import {fragmentShader as legacy} from './shaders.js';
import {CORNERS,FACES,EDGES} from './explicit-grid.js';
export {vertexShader} from './shaders.js';
const ramp=legacy.slice(legacy.indexOf('vec3 ramp('),legacy.indexOf('float segmentDistance('));
const background=legacy.slice(legacy.indexOf('vec3 background('),legacy.indexOf('\nvoid main()'));
const table=(type,name,rows)=>`const ${type} ${name}[${rows.length}]=${type}[${rows.length}](${rows.map(r=>`${type}(${r.join(',')})`).join(',')});`;
export const explicitFragmentShader=`#version 300 es
precision highp float;
precision highp int;
precision highp sampler3D;
precision highp sampler2D;
precision highp usampler2D;
uniform sampler3D uAttributes,uVertices;
uniform sampler2D uNodes,uRanges;
uniform highp usampler2D uColumnPillars,uKInterfaces;
uniform int uImported,uPropertyLog;
uniform vec2 uPropertyRange;
uniform ivec3 uDimensions,uSplits;
uniform int uNodeWidth,uNodeCount,uCellCount,uSkipBricks,uNoMatches,uSurfacePreview;
uniform vec2 uPhi,uResolution;
uniform vec3 uEye,uForward,uRight,uUp,uBoundsMin,uBoundsMax;
uniform float uTanFov,uDensity,uEdgeWidth,uPixelRatio,uClipPosition;
uniform int uProperty,uPorosityFilter,uEdges,uInterior,uClipAxis;
out vec4 outColor;
const float INF=1e25,EPS=1.5e-6;
${table('ivec3','CORNERS',CORNERS)}
${table('ivec3','TRIANGLES',FACES)}
${table('ivec2','EDGES',EDGES)}
const ivec3 NEIGHBORS[6]=ivec3[6](ivec3(0,0,-1),ivec3(0,0,1),ivec3(0,-1,0),ivec3(0,1,0),ivec3(-1,0,0),ivec3(1,0,0));
vec3 v[8];float winding=1.0;
${ramp}
${background}
vec4 node(int index){return texelFetch(uNodes,ivec2(index%uNodeWidth,index/uNodeWidth),0);}
vec2 rangeAt(int id){return texelFetch(uRanges,ivec2(id%uNodeWidth,id/uNodeWidth),0).rg;}
bool matches(vec4 p){return p.a>0.5&&(uPorosityFilter==0||(p.g>=uPhi.x&&p.g<=uPhi.y));}
bool valid(ivec3 c){return all(greaterThanEqual(c,ivec3(0)))&&all(lessThan(c,uDimensions));}
int blockX(int i){return int(i>=uSplits.x)+int(i>=uSplits.y)+int(i>=uSplits.z);}
void corners(ivec3 cell){
  winding=1.0;
  if(uImported==1){
    uvec4 pillars=texelFetch(uColumnPillars,cell.xy,0);uvec2 layers=texelFetch(uKInterfaces,ivec2(cell.z,0),0).rg;int width=textureSize(uVertices,0).x;
    for(int i=0;i<8;i++){int p=int(pillars[i%4]);v[i]=texelFetch(uVertices,ivec3(p%width,p/width,int(layers[i/4])),0).xyz;}
    winding=texelFetch(uAttributes,cell,0).a>1.5?-1.0:1.0;
  }else{ivec3 n=cell+ivec3(blockX(cell.x),int(cell.y>=uDimensions.y/2),0);for(int i=0;i<8;i++)v[i]=texelFetch(uVertices,n+CORNERS[i],0).xyz;}
}
vec3 propertyColor(vec4 p){
  if(uImported==0){float value=uProperty==0?(p.r-.05)/.80:(uProperty==1?(p.g-.08)/.24:log(p.b/.5)/log(3000.0));return ramp(value);}
  float raw=p[uProperty];if(isnan(raw)||isinf(raw))return vec3(.38,.50,.56);
  vec2 range=uPropertyRange;
  if(uPropertyLog==1){if(raw<=0.0)return vec3(.38,.50,.56);raw=log(raw);range=log(max(range,vec2(1e-30)));}
  return ramp(range.y>range.x?(raw-range.x)/(range.y-range.x):.5);
}
// Outward-wound triangles. The face diagonal is never drawn as a grid edge.
bool triangle(vec3 ro,vec3 rd,int i,out float t,out vec3 normal){
  ivec3 tri=TRIANGLES[i];vec3 a=v[tri.x]-ro,b=v[tri.y]-ro,c=v[tri.z]-ro;
  // Project along the dominant ray component. Shared edges use the same
  // endpoint arithmetic; no expanded barycentric epsilon creates false hits.
  vec3 ad=abs(rd);int kz=ad.x>ad.y?(ad.x>ad.z?0:2):(ad.y>ad.z?1:2);
  int kx=(kz+1)%3,ky=(kx+1)%3;vec2 shear=vec2(rd[kx],rd[ky])/rd[kz];
  vec2 pa=vec2(a[kx],a[ky])-shear*a[kz],pb=vec2(b[kx],b[ky])-shear*b[kz],pc=vec2(c[kx],c[ky])-shear*c[kz];
  float u=pc.x*pb.y-pc.y*pb.x,w=pb.x*pa.y-pb.y*pa.x,q=pa.x*pc.y-pa.y*pc.x;
  if((min(u,min(w,q))<0.0&&max(u,max(w,q))>0.0))return false;
  float det=u+w+q;if(det==0.0)return false;
  t=(u*a[kz]+q*b[kz]+w*c[kz])/(det*rd[kz]);
  normal=winding*cross(v[tri.y]-v[tri.x],v[tri.z]-v[tri.x]);return true;
}
bool cellInterval(ivec3 c,vec3 ro,vec3 rd,float lower,float upper,out float a,out float b,out vec3 normal,out int face){
  corners(c);float entries[12],front=-INF,back=INF;int bf=-1,entry=-1;
  for(int i=0;i<12;i++){
    entries[i]=-INF;float t;vec3 n;if(!triangle(ro,rd,i,t,n))continue;
    if(dot(n,rd)<0.0)entries[i]=t;
    else if(t>=lower-EPS&&t<back){back=t;bf=i/2;}
  }
  // Require a real entering face even if it is behind lower/the camera.
  // A lone exit hit must never turn the entire eye-to-cell distance opaque.
  for(int i=0;i<12;i++)if(entries[i]<=back&&entries[i]>front){front=entries[i];entry=i;}
  if(entry<0||back>=INF)return false;
  ivec3 tri=TRIANGLES[entry];normal=normalize(winding*cross(v[tri.y]-v[tri.x],v[tri.z]-v[tri.x]));
  a=max(lower,front);
  b=min(back,upper);face=back>upper? -1:bf;
  return a<INF&&b>a+EPS&&back<INF;
}
float nodeNear(int id,vec3 ro,vec3 inv,float lower,float upper){
  vec2 range=rangeAt(id);if(range.x>range.y||(uSkipBricks==1&&uPorosityFilter==1&&(range.y<uPhi.x||range.x>uPhi.y)))return INF;
  vec3 t0=(node(id*2).xyz-ro)*inv,t1=(node(id*2+1).xyz-ro)*inv;
  vec3 lo=min(t0,t1),hi=max(t0,t1);float a=max(lower,max(lo.x,max(lo.y,lo.z))),b=min(upper,min(hi.x,min(hi.y,hi.z)));
  return b>=a-EPS?a:INF;
}
bool findCell(vec3 ro,vec3 rd,vec3 inv,float lower,float upper,out ivec3 cell,out float a,out float b,out vec3 normal,out int face){
  int stack[32],top=0;stack[top++]=0;a=INF;bool found=false;
  // Every node can be visited at most once; no arbitrary traversal truncation.
  for(int visit=0;visit<uNodeCount;visit++){
    if(top==0)break;int id=stack[--top];
    if(nodeNear(id,ro,inv,lower,min(upper,a))>=INF)continue;
    vec4 hi=node(id*2+1);int leaf=int(hi.w)-1;
    if(leaf>=0){
      ivec3 g=(uDimensions+ivec3(1))/2,c=ivec3(leaf%g.x,(leaf/g.x)%g.y,leaf/(g.x*g.y))*2;
      for(int i=0;i<8;i++){
        ivec3 candidate=c+ivec3(i&1,(i>>1)&1,(i>>2)&1);if(!valid(candidate)||!matches(texelFetch(uAttributes,candidate,0)))continue;
        float ca,cb;vec3 cn;int cf;
        if(cellInterval(candidate,ro,rd,lower,upper,ca,cb,cn,cf)&&ca<a){found=true;cell=candidate;a=ca;b=cb;normal=cn;face=cf;}
      }
    }else{
      int left=id+1,right=int(node(left*2).w);
      float ta=nodeNear(left,ro,inv,lower,min(upper,a)),tb=nodeNear(right,ro,inv,lower,min(upper,a));
      if(ta<tb){if(tb<INF)stack[top++]=right;if(ta<INF)stack[top++]=left;}
      else{if(ta<INF)stack[top++]=left;if(tb<INF)stack[top++]=right;}
    }
  }
  return found;
}
float segmentDistance(vec3 p,vec3 a,vec3 b){vec3 d=b-a;return length(p-a-d*clamp(dot(p-a,d)/max(dot(d,d),1e-20),0.0,1.0));}
float gridDistance(vec3 p,bool section){
  float d=INF;
  if(!section){for(int i=0;i<12;i++)d=min(d,segmentDistance(p,v[EDGES[i].x],v[EDGES[i].y]));}
  else{
    int axis=uClipAxis-1;
    for(int i=0;i<12;i++){
      ivec3 tri=TRIANGLES[i];vec3 points[3];int count=0;
      for(int j=0;j<3;j++){
        vec3 a=v[tri[j]],b=v[tri[(j+1)%3]];float da=a[axis]-uClipPosition,db=b[axis]-uClipPosition;
        if((da<=0.0&&db>0.0)||(db<=0.0&&da>0.0))points[count++]=mix(a,b,da/(da-db));
      }
      if(count==2)d=min(d,segmentDistance(p,points[0],points[1]));
    }
  }
  return d;
}
void composite(inout vec4 acc,vec3 color,float alpha){float w=(1.0-acc.a)*clamp(alpha,0.0,1.0);acc+=vec4(w*color,w);}
void gridLine(inout vec4 acc,vec3 p,float t,bool interior,bool section){
  float pixel=max(1e-7,2.0*uTanFov*t/uResolution.y),size=INF;
  for(int i=0;i<12;i++)size=min(size,length(v[EDGES[i].x]-v[EDGES[i].y]));
  float width=min(uEdgeWidth*uPixelRatio*pixel,size*.19),d=gridDistance(p,section);
  float coverage=(1.0-smoothstep(width*.2,width+pixel*.65,d))*min(1.0,width/(pixel*.55));
  float transparent=1.0-smoothstep(.4,5.0,uDensity);
  vec3 color=mix(vec3(.028,.045,.058),vec3(.39,.60,.64),transparent*(interior?1.0:.42));
  composite(acc,color,coverage*(interior?mix(.16,.62,1.0-transparent):.88));
}
bool connected(ivec3 c,ivec3 next){
  if(!valid(next))return false;
  if(uImported==0)return blockX(c.x)==blockX(next.x)&&(c.y>=uDimensions.y/2)==(next.y>=uDimensions.y/2);
  if(c.z!=next.z){int lo=min(c.z,next.z);return texelFetch(uKInterfaces,ivec2(lo,0),0).g==texelFetch(uKInterfaces,ivec2(lo+1,0),0).r;}
  uvec4 a=texelFetch(uColumnPillars,c.xy,0),b=texelFetch(uColumnPillars,next.xy,0);
  if(next.x>c.x)return a.y==b.x&&a.z==b.w;
  if(next.x<c.x)return a.x==b.y&&a.w==b.z;
  if(next.y>c.y)return a.w==b.x&&a.z==b.y;
  return a.x==b.w&&a.y==b.z;
}
void main(){
  vec2 xy=(gl_FragCoord.xy*2.0-uResolution)/uResolution.y;
  vec3 rd=normalize(uForward+uTanFov*(xy.x*uRight+xy.y*uUp)),ro=uEye;
  vec3 inv=mix(vec3(-1),vec3(1),greaterThanEqual(rd,vec3(0)))/max(abs(rd),vec3(1e-12));
  vec3 bg=background(ro,rd,inv);float clipNear=0.0,clipFar=INF;
  if(uClipAxis>0){int axis=uClipAxis-1;if(abs(rd[axis])<1e-10){if(ro[axis]>uClipPosition){outColor=vec4(bg,1);return;}}
    else{float t=(uClipPosition-ro[axis])/rd[axis];if(rd[axis]<0.0)clipNear=max(0.0,t);else clipFar=t;}}
  if(clipFar<=clipNear||uNoMatches==1){outColor=vec4(bg,1);return;}
  vec4 acc=vec4(0);ivec3 cell;float a,b;vec3 normal;int face;
  bool found=findCell(ro,rd,inv,clipNear,clipFar,cell,a,b,normal,face),continuous=false;
  // Interaction preview uses the FIRST ACTUAL matching surface, including
  // its real cell edges and clipping intersection. Full volume returns at rest.
  if(uSurfacePreview==1){
    if(found){
      corners(cell);vec4 p=texelFetch(uAttributes,cell,0);
      bool section=uClipAxis>0&&clipNear>0.0&&abs(a-clipNear)<EPS*3.0;
      if(section){normal=vec3(0);normal[uClipAxis-1]=1.0;}
      if(uEdges==1)gridLine(acc,ro+rd*a,a,false,section);
      composite(acc,propertyColor(p)*(.78+.22*abs(dot(normal,normalize(vec3(.4,-.6,.8))))),1.0);
    }
    outColor=vec4(acc.rgb+(1.0-acc.a)*bg,1);return;
  }
  // Twelve triangles bound at most six disjoint ray intervals per cell.
  for(int step=0;step<uCellCount*6;step++){
    if(!found||acc.a>.997)break;corners(cell);
    vec4 property=texelFetch(uAttributes,cell,0);bool keep=matches(property);
    // Filtering changes visibility, not geometric adjacency. Walking through
    // excluded neighbors avoids restarting a multi-million-node BVH per gap.
    ivec3 next=cell;bool neighbor=false,nextVisible=false;
    if(face>=0){next+=NEIGHBORS[face];neighbor=connected(cell,next);if(neighbor)nextVisible=matches(texelFetch(uAttributes,next,0));}
    if(keep){
      bool section=uClipAxis>0&&clipNear>0.0&&abs(a-clipNear)<EPS*3.0;
      if(section){normal=vec3(0);normal[uClipAxis-1]=1.0;}
      if(uEdges==1&&(!continuous||uInterior==1))gridLine(acc,ro+rd*a,a,continuous&&!section,section);
      float light=.78+.22*abs(dot(normal,normalize(vec3(.4,-.6,.8))));
      composite(acc,propertyColor(property)*light,1.0-exp(-uDensity*(b-a)));
      if(uEdges==1&&!nextVisible){bool cut=uClipAxis>0&&abs(b-clipFar)<EPS*3.0;gridLine(acc,ro+rd*b,b,false,cut);}
    }
    if(b>=clipFar-EPS)break;
    float end=b;continuous=false;
    if(neighbor){
      float na,nb;vec3 nn;int nf;
      if(cellInterval(next,ro,rd,end+EPS,clipFar,na,nb,nn,nf)&&na<=end+EPS*3.0){cell=next;a=end;b=nb;normal=nn;face=nf;continuous=keep&&nextVisible;continue;}
    }
    found=findCell(ro,rd,inv,end+EPS*2.0,clipFar,cell,a,b,normal,face);
  }
  outColor=vec4(acc.rgb+(1.0-acc.a)*bg,1);
}`;
