import {fragmentShader as legacy} from './shaders.js';
export {vertexShader} from './shaders.js';
const ramp=legacy.slice(legacy.indexOf('vec3 ramp('),legacy.indexOf('float segmentDistance('));
const background=legacy.slice(legacy.indexOf('vec3 background('),legacy.indexOf('\nvoid main()'));
export const largeFragmentShader=`#version 300 es
precision highp float;
precision highp int;
precision highp usampler3D;
precision highp sampler2D;
uniform usampler3D uAttributes,uBricks;
uniform sampler2D uAxes,uFold;
uniform ivec3 uDimensions;
uniform ivec2 uPhi;
uniform vec2 uResolution;
uniform vec3 uEye,uForward,uRight,uUp,uBoundsMin,uBoundsMax;
uniform float uTanFov,uDensity,uEdgeWidth,uPixelRatio,uClipPosition;
uniform int uProperty,uPorosityFilter,uEdges,uInterior,uClipAxis,uSkipBricks;
out vec4 outColor;
const float INF=1e25,EPS=1e-6;
const int B=10;
const vec2 SHEAR=vec2(.11,.055);
${ramp}
${background}
float coord(int i,int axis){return texelFetch(uAxes,ivec2(i,0),0)[axis];}
int locate(float v,int axis,int low,int high,int stride){
  int lo=low,hi=high;
  for(int step=0;step<10;step++){if(hi-lo<=1)break;int m=(lo+hi)/2;if(v<coord(m*stride,axis))hi=m;else lo=m;}
  return lo;
}
vec3 unShear(vec3 p){return vec3(p.xy-SHEAR*p.z,p.z);}
vec3 worldVector(vec3 p,vec2 slopes){float z=p.z+dot(p.xy,slopes);return vec3(p.xy+SHEAR*z,z);}
vec3 cellNormal(int axis,float signValue,vec2 slopes){
  if(axis==0)return signValue*normalize(vec3(1,0,-SHEAR.x));
  if(axis==1)return signValue*normalize(vec3(0,1,-SHEAR.y));
  return signValue*normalize(vec3(-slopes,1.0+dot(slopes,SHEAR)));
}
bool slab(float origin,float direction,float lo,float hi,inout float a,inout float b){
  if(abs(direction)<1e-10)return origin>=lo&&origin<=hi;
  float t0=(lo-origin)/direction,t1=(hi-origin)/direction;
  a=max(a,min(t0,t1));b=min(b,max(t0,t1));return b>a+EPS;
}
float crossing(float origin,float direction,float plane){return abs(direction)<1e-10?INF:(plane-origin)/direction;}
bool matches(uvec4 p){return p.a>0u&&(uPorosityFilter==0||(int(p.g)>=uPhi.x&&int(p.g)<=uPhi.y));}
void composite(inout vec4 acc,vec3 color,float alpha){float w=(1.0-acc.a)*clamp(alpha,0.0,1.0);acc+=vec4(w*color,w);}
vec3 nearNormal(vec3 p,vec3 lo,vec3 hi,vec3 direction,vec2 slopes){
  vec3 d=min(abs(p-lo),abs(hi-p));int axis=d.x<d.y?(d.x<d.z?0:2):(d.y<d.z?1:2);
  return cellNormal(axis,direction[axis]>0.0?-1.0:1.0,slopes);
}
float edgeDistance(vec3 p,vec3 size,vec2 slopes){
  float result=INF;vec3 wp=worldVector(p,slopes);
  // Only the original 12 hexahedron edges; no brick seams or face diagonals.
  for(int axis=0;axis<3;axis++){
    int b=(axis+1)%3,c=(axis+2)%3;
    vec3 edge=vec3(0);edge[axis]=size[axis];edge=worldVector(edge,slopes);
    for(int k=0;k<4;k++){
      vec3 start=vec3(0);start[b]=float(k&1)*size[b];start[c]=float((k>>1)&1)*size[c];
      vec3 delta=wp-worldVector(start,slopes);
      float t=clamp(dot(delta,edge)/dot(edge,edge),0.0,1.0);result=min(result,length(delta-edge*t));
    }
  }
  return result;
}
void gridLine(inout vec4 acc,vec3 q,vec3 lo,vec3 hi,vec2 slopes,float t,bool interior,bool section){
  vec3 size=hi-lo;float pixel=max(1e-7,2.0*uTanFov*t/uResolution.y);
  // Cap the physical stroke to preserve cell interiors at distant views.
  float minSize=min(size.x,min(size.y,size.z));float width=min(uEdgeWidth*uPixelRatio*pixel,minSize*.19);
  vec3 d=min(abs(q-lo),abs(hi-q));float second=max(min(d.x,d.y),min(max(d.x,d.y),d.z));
  if(!section&&second>max(width,pixel)*2.5)return;
  float distance=INF;
  if(section){
    vec3 clipN=vec3(0);clipN[uClipAxis-1]=1.0;
    for(int axis=0;axis<3;axis++){
      vec3 gradient=axis==0?vec3(1,0,-SHEAR.x):(axis==1?vec3(0,1,-SHEAR.y):vec3(-slopes,1.0+dot(slopes,SHEAR)));
      float projected=length(gradient-dot(gradient,clipN)*clipN);
      if(projected>1e-8)distance=min(distance,d[axis]/projected);
    }
  }else distance=edgeDistance(q-lo,size,slopes);
  float coverage=(1.0-smoothstep(width*.2,width+pixel*.65,distance))*min(1.0,width/(pixel*.55));
  float transparent=1.0-smoothstep(.4,5.0,uDensity);
  vec3 color=mix(vec3(.028,.045,.058),vec3(.39,.60,.64),transparent*(interior?1.0:.42));
  float strength=interior?mix(.16,.62,1.0-transparent):.88;
  composite(acc,color,coverage*strength);
}
bool inBlock(ivec3 cell,int block){int split=uDimensions.x/2;return all(greaterThanEqual(cell,ivec3(0)))&&all(lessThan(cell,uDimensions))&&(block==0?cell.x<split:cell.x>=split);}
void fineBrick(vec3 ro,vec3 rd,float a,float b,ivec3 brick,vec2 slopes,int block,float clipNear,inout vec4 acc,inout bool visible){
  ivec3 lower=brick*B,upper=lower+ivec3(B),cell;
  vec3 p=ro+rd*min(b,a+EPS*2.0);
  for(int axis=0;axis<3;axis++)cell[axis]=locate(p[axis],axis,lower[axis],upper[axis],1);
  ivec3 step=ivec3(sign(rd));
  float current=a;
  // A ray can cross at most 3*B cells in one B-cubed brick.
  for(int iteration=0;iteration<34;iteration++){
    if(current>=b-EPS||acc.a>.997||any(lessThan(cell,lower))||any(greaterThanEqual(cell,upper)))break;
    vec3 lo,hi,next;
    for(int axis=0;axis<3;axis++){lo[axis]=coord(cell[axis],axis);hi[axis]=coord(cell[axis]+1,axis);next[axis]=crossing(ro[axis],rd[axis],rd[axis]>0.0?hi[axis]:lo[axis]);}
    float end=min(b,min(next.x,min(next.y,next.z)));
    if(end<=current+EPS){
      if(b<=current+EPS)break;
      for(int axis=0;axis<3;axis++)if(next[axis]<=current+EPS)cell[axis]+=step[axis];
      continue;
    }
    uvec4 property=texelFetch(uAttributes,cell,0);
    if(end>current+1e-8&&matches(property)){
      vec3 entry=ro+rd*current;vec3 normal=nearNormal(entry,lo,hi,rd,slopes);
      bool section=uClipAxis>0&&clipNear>0.0&&abs(current-clipNear)<EPS*4.0;
      if(section){normal=vec3(0);normal[uClipAxis-1]=1.0;}
      float scalar=float(property[uProperty])/255.0;
      float lighting=.66+.34*max(0.0,dot(normal,normalize(vec3(-.3,-.5,.85))));
      if(uEdges==1&&(uInterior==1||!visible))gridLine(acc,entry,lo,hi,slopes,current,visible,section);
      composite(acc,ramp(scalar)*lighting,1.0-exp(-uDensity*(.8+.4*scalar)*(end-current)));
      ivec3 after=cell;for(int axis=0;axis<3;axis++)if(next[axis]<=end+EPS*.2)after[axis]+=step[axis];
      bool exposed=!inBlock(after,block);
      if(!exposed&&any(notEqual(after,cell)))exposed=!matches(texelFetch(uAttributes,after,0));
      bool clipped=end<min(next.x,min(next.y,next.z))-EPS;
      if(uEdges==1&&uInterior==1&&(exposed||clipped))gridLine(acc,ro+rd*end,lo,hi,slopes,end,true,clipped&&uClipAxis>0);
      visible=true;
    }
    for(int axis=0;axis<3;axis++)if(next[axis]<=end+EPS*.2)cell[axis]+=step[axis];
    current=end;
  }
}
vec2 blockInterval(vec3 baseRo,vec3 baseRd,int block,float clipNear,float clipFar){
  float shift=block==0?-.075:.075;
  int split=uDimensions.x/2,first=block==0?0:split,last=block==0?split:uDimensions.x;
  float a=clipNear,b=clipFar;
  if(!slab(baseRo.x-shift,baseRd.x,coord(first,0),coord(last,0),a,b)||!slab(baseRo.y,baseRd.y,coord(0,1),coord(uDimensions.y,1),a,b)||!slab(baseRo.z,baseRd.z,uBoundsMin.z,uBoundsMax.z,a,b))return vec2(INF,-INF);
  return vec2(a,b);
}
void castBlock(vec3 baseRo,vec3 baseRd,int block,vec2 interval,float clipNear,inout vec4 acc,inout bool visible){
  if(interval.y<=interval.x)return;
  vec3 ro=baseRo;ro.x-=block==0?-.075:.075;
  int first=block==0?0:uDimensions.x/(2*B),last=block==0?uDimensions.x/(2*B):uDimensions.x/B;
  float current=interval.x;
  vec3 initial=ro+baseRd*(current+EPS*2.0);
  int i=locate(initial.x,0,first,last,B),j=locate(initial.y,1,0,uDimensions.y/B,B);
  // 20M has 50x40 macro columns; 128 exceeds the longest XY traversal.
  for(int outer=0;outer<128;outer++){
    if(current>=interval.y-EPS||acc.a>.997||i<first||i>=last||j<0||j>=uDimensions.y/B)break;
    vec2 low=vec2(coord(i*B,0),coord(j*B,1)),high=vec2(coord((i+1)*B,0),coord((j+1)*B,1));
    vec2 next=vec2(crossing(ro.x,baseRd.x,baseRd.x>0.0?high.x:low.x),crossing(ro.y,baseRd.y,baseRd.y>0.0?high.y:low.y));
    float end=min(interval.y,min(next.x,next.y));
    // Keep integer DDA coordinates across columns. Re-locating with a tiny
    // ray-time nudge can round back onto the old plane on near-vertical rays.
    if(end<=current+EPS){
      if(next.x<=current+EPS)i+=baseRd.x>0.0?1:-1;
      if(next.y<=current+EPS)j+=baseRd.y>0.0?1:-1;
      continue;
    }
    vec2 f0=vec2(texelFetch(uFold,ivec2(i,0),0).r,texelFetch(uFold,ivec2(j,0),0).g);
    vec2 f1=vec2(texelFetch(uFold,ivec2(i+1,0),0).r,texelFetch(uFold,ivec2(j+1,0),0).g);
    vec2 slopes=(f1-f0)/(high-low);
    float intercept=f0.x+f0.y-dot(slopes,low)-(block==1?.37:0.0);
    vec3 qr=vec3(ro.xy,ro.z-intercept-dot(slopes,ro.xy));
    vec3 qd=vec3(baseRd.xy,baseRd.z-dot(slopes,baseRd.xy));
    float a=current,b=end;
    if(slab(qr.z,qd.z,coord(0,2),coord(uDimensions.z,2),a,b)){
      int k=locate((qr+qd*(a+EPS*2.0)).z,2,0,uDimensions.z/B,B);
      for(int zstep=0;zstep<12;zstep++){
        if(a>=b-EPS||acc.a>.997||k<0||k>=uDimensions.z/B)break;
        float ze=min(b,crossing(qr.z,qd.z,coord((qd.z>0.0?k+1:k)*B,2)));
        if(ze<=a+EPS){k+=qd.z>0.0?1:-1;continue;}
        uvec4 range=texelFetch(uBricks,ivec3(i,j,k),0);
        bool keep=uSkipBricks==0||uPorosityFilter==0||(int(range.g)>=uPhi.x&&int(range.r)<=uPhi.y);
        if(keep)fineBrick(qr,qd,a,ze,ivec3(i,j,k),slopes,block,clipNear,acc,visible);
        a=ze;k+=qd.z>0.0?1:-1;
      }
    }
    current=end;
    if(next.x<=end+EPS*.2)i+=baseRd.x>0.0?1:-1;
    if(next.y<=end+EPS*.2)j+=baseRd.y>0.0?1:-1;
  }
}
void main(){
  vec2 xy=(gl_FragCoord.xy*2.0-uResolution)/uResolution.y;
  vec3 rd=normalize(uForward+uTanFov*(xy.x*uRight+xy.y*uUp)),ro=uEye;
  vec3 invDir=sign(rd)/max(abs(rd),vec3(1e-12));vec3 bg=background(ro,rd,invDir);
  float clipNear=0.0,clipFar=INF;
  if(uClipAxis>0){int axis=uClipAxis-1;if(abs(rd[axis])<1e-10){if(ro[axis]>uClipPosition){outColor=vec4(bg,1);return;}}
    else {float t=(uClipPosition-ro[axis])/rd[axis];if(rd[axis]<0.0)clipNear=max(0.0,t);else clipFar=t;}}
  if(clipFar<=clipNear){outColor=vec4(bg,1);return;}
  vec3 baseRo=unShear(ro),baseRd=unShear(rd);vec4 acc=vec4(0);bool visible=false;
  vec2 left=blockInterval(baseRo,baseRd,0,clipNear,clipFar),right=blockInterval(baseRo,baseRd,1,clipNear,clipFar);
  if(left.x<right.x){castBlock(baseRo,baseRd,0,left,clipNear,acc,visible);castBlock(baseRo,baseRd,1,right,clipNear,acc,visible);}
  else {castBlock(baseRo,baseRd,1,right,clipNear,acc,visible);castBlock(baseRo,baseRd,0,left,clipNear,acc,visible);}
  outColor=vec4(acc.rgb+(1.0-acc.a)*bg,1);
}`;
