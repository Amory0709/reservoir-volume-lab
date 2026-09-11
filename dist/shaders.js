export const vertexShader = `#version 300 es
precision highp float;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export const fragmentShader = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
out vec4 outColor;
uniform sampler2D uTets, uCells, uNodes, uTriangles;
uniform vec2 uResolution;
uniform vec2 uPorosityRange;
uniform vec3 uEye, uRight, uUp, uForward;
uniform vec3 uBoundsMin, uBoundsMax;
uniform float uTanFov, uDensity, uEdgeWidth, uClipPosition, uPixelRatio;
uniform int uProperty, uEdges, uInterior, uClipAxis, uNodeCount, uPorosityFilter;
const float INF = 1e20;
const float EPS = 0.000008;
const ivec2 EDGES[12] = ivec2[12](ivec2(0,1),ivec2(1,2),ivec2(2,3),ivec2(3,0),ivec2(4,5),ivec2(5,6),ivec2(6,7),ivec2(7,4),ivec2(0,4),ivec2(1,5),ivec2(2,6),ivec2(3,7));
const ivec4 FACES[6] = ivec4[6](ivec4(0,1,2,3),ivec4(4,5,6,7),ivec4(0,1,5,4),ivec4(3,2,6,7),ivec4(0,3,7,4),ivec4(1,2,6,5));
vec4 fetchAt(sampler2D tex, int n) { return texelFetch(tex, ivec2(n % 1024, n / 1024), 0); }
bool matchesPorosity(vec4 properties) {
  return uPorosityFilter==0 || (properties.y>=uPorosityRange.x && properties.y<=uPorosityRange.y);
}

bool boxHit(vec3 ro, vec3 invDir, vec3 lo, vec3 hi, float lower, float upper) {
  vec3 a=(lo-ro)*invDir, b=(hi-ro)*invDir;
  vec3 nearV=min(a,b), farV=max(a,b);
  float nearT=max(max(nearV.x,nearV.y),nearV.z);
  float farT=min(min(farV.x,farV.y),farV.z);
  return farT>=max(nearT,lower) && nearT<upper;
}

// Find the first entering surface, including re-entry after a fault or void.
// The BVH contains only true exterior faces; internal tetra faces are absent.
bool findEntry(vec3 ro,vec3 rd,vec3 invDir,float lower,out float best,out int tet,out vec3 normal) {
  best=INF; tet=-1; normal=vec3(0,0,1);
  int n=0;
  for(int visit=0;visit<2048;visit++) {
    if(n>=uNodeCount) break;
    vec4 lo=fetchAt(uNodes,n*3), hi=fetchAt(uNodes,n*3+1);
    if(!boxHit(ro,invDir,lo.xyz,hi.xyz,lower,best)) {n=int(lo.w);continue;}
    int count=int(hi.w);
    if(count>0) {
      int first=int(fetchAt(uNodes,n*3+2).x);
      for(int j=0;j<6;j++) {
        if(j>=count) break;
        int q=(first+j)*3;
        vec4 a=fetchAt(uTriangles,q);
        vec3 e1=fetchAt(uTriangles,q+1).xyz, e2=fetchAt(uTriangles,q+2).xyz;
        vec3 p=cross(rd,e2); float det=dot(e1,p);
        // Outward-facing triangle: positive det means an entering ray.
        if(det<0.00000001) continue;
        float invDet=1.0/det;
        vec3 s=ro-a.xyz;
        float u=dot(s,p)*invDet;
        if(u < -0.000001 || u > 1.000001) continue;
        vec3 qv=cross(s,e1); float v=dot(rd,qv)*invDet;
        if(v < -0.000001 || u+v > 1.000001) continue;
        float t=dot(e2,qv)*invDet;
        if(t>lower && t<best) {best=t;tet=int(a.w);normal=normalize(cross(e1,e2));}
      }
    }
    n++;
  }
  return tet>=0;
}

vec3 ramp(float x) {
  vec3 c0=vec3(.137,.310,.678), c1=vec3(.153,.549,.706), c2=vec3(.322,.776,.627);
  vec3 c3=vec3(.878,.867,.412), c4=vec3(.976,.608,.275), c5=vec3(.827,.231,.208);
  float t=clamp(x,0.0,0.99999)*5.0;
  if(t<1.0) return mix(c0,c1,t);
  if(t<2.0) return mix(c1,c2,t-1.0);
  if(t<3.0) return mix(c2,c3,t-2.0);
  if(t<4.0) return mix(c3,c4,t-3.0);
  return mix(c4,c5,t-4.0);
}
float segmentDistance(vec3 p,vec3 a,vec3 b) {
  vec3 e=b-a; return length(p-a-e*clamp(dot(p-a,e)/dot(e,e),0.0,1.0));
}
float triangleDistance(vec3 p,vec3 a,vec3 b,vec3 c) {
  vec3 ba=b-a,pa=p-a,cb=c-b,pb=p-b,ac=a-c,pc=p-c;
  vec3 nor=cross(ba,ac);
  bool outside=sign(dot(cross(ba,nor),pa))+sign(dot(cross(cb,nor),pb))+sign(dot(cross(ac,nor),pc))<2.0;
  if(outside) return min(segmentDistance(p,a,b),min(segmentDistance(p,b,c),segmentDistance(p,c,a)));
  return abs(dot(nor,pa))/length(nor);
}

// Only the original 12 hexahedral edges are eligible for a line.
// On an arbitrary clipping plane, lines are its intersections with hex faces.
float gridDistance(vec3 p,int hex,bool section) {
  vec3 c[8]; for(int i=0;i<8;i++) c[i]=fetchAt(uCells,hex*9+i).xyz;
  float d=INF;
  if(section) {
    for(int i=0;i<6;i++) {
      ivec4 f=FACES[i];
      d=min(d,min(triangleDistance(p,c[f.x],c[f.y],c[f.z]),triangleDistance(p,c[f.x],c[f.z],c[f.w])));
    }
  } else {
    for(int i=0;i<12;i++) d=min(d,segmentDistance(p,c[EDGES[i].x],c[EDGES[i].y]));
  }
  return d;
}

// Premultiplied front-to-back composition. Lines obey the same transmittance.
void composite(inout vec4 acc,vec3 color,float a) {
  float contribution=(1.0-acc.a)*clamp(a,0.0,1.0);
  acc.rgb+=contribution*color; acc.a+=contribution;
}
void gridLine(inout vec4 acc,vec3 p,int hex,float t,bool section,bool interior) {
  float d=gridDistance(p,hex,section);
  float pixel=2.0*uTanFov*t/uResolution.y;
  float width=uEdgeWidth*uPixelRatio*pixel;
  float coverage=1.0-smoothstep(width*.38,width*1.15,d);
  float transparent=1.0-smoothstep(.4,5.0,uDensity);
  vec3 lineColor=mix(vec3(.025,.041,.051),vec3(.40,.61,.64),transparent*(interior?1.0:.42));
  float strength=interior?mix(.23,.72,1.0-transparent):.9;
  composite(acc,lineColor,coverage*strength);
}

vec3 background(vec3 ro,vec3 rd,vec3 invDir) {
  vec2 uv=gl_FragCoord.xy/uResolution;
  float halo=exp(-3.2*dot((uv-vec2(.5,.48))*vec2(1.1,1.0),(uv-vec2(.5,.48))*vec2(1.1,1.0)));
  vec3 bg=mix(vec3(.035,.054,.074),vec3(.075,.112,.145),halo);
  float floorZ=uBoundsMin.z-.25;
  if(rd.z < -.0001) {
    float t=(floorZ-ro.z)/rd.z;
    vec2 p=(ro+rd*t).xy;
    float distanceFade=exp(-.045*dot(p,p));
    float pixel=max(.001,2.0*t*uTanFov/uResolution.y);
    vec2 grid=abs(fract(p+.5)-.5);
    float line=1.0-smoothstep(pixel*.22,pixel*.9,min(grid.x,grid.y));
    bg=mix(bg,vec3(.15,.205,.246),line*distanceFade*.3);
    float shadow=exp(-.17*p.x*p.x-.36*p.y*p.y);
    bg*=1.0-.17*shadow;
  }
  return bg;
}

void main() {
  vec2 xy=(gl_FragCoord.xy*2.0-uResolution)/uResolution.y;
  vec3 ro=uEye,rd=normalize(uForward+uTanFov*(xy.x*uRight+xy.y*uUp));
  vec3 invDir=vec3(rd.x>=0.0?1.0:-1.0,rd.y>=0.0?1.0:-1.0,rd.z>=0.0?1.0:-1.0)/max(abs(rd),vec3(1e-12));
  vec3 bg=background(ro,rd,invDir);
  if(!boxHit(ro,invDir,uBoundsMin,uBoundsMax,0.0,INF)) {outColor=vec4(bg,1);return;}
  float clipNear=0.0,clipFar=INF;
  vec3 clipNormal=vec3(0.0);
  if(uClipAxis>0) {
    int a=uClipAxis-1; clipNormal[a]=1.0;
    if(abs(rd[a])<1e-8) {if(ro[a]>uClipPosition){outColor=vec4(bg,1);return;}}
    else {
      float t=(uClipPosition-ro[a])/rd[a];
      if(rd[a]<0.0) clipNear=max(0.0,t); else clipFar=t;
      if(clipFar<=clipNear){outColor=vec4(bg,1);return;}
    }
  }
  float current; int tet; vec3 entryNormal;
  if(!findEntry(ro,rd,invDir,0.0,current,tet,entryNormal)) {outColor=vec4(bg,1);return;}
  vec4 acc=vec4(0.0);
  int prevTet=-1,prevHex=-1,colorHex=-1;
  bool visible=false;
  vec3 color=vec3(0); float extinction=0.0;
  for(int step=0;step<640;step++) {
    if(tet<0 || current>=clipFar || acc.a>.997) break;
    int hex=tet/6;
    vec4 neighbors=fetchAt(uTets,tet*5+4);
    float leave=INF; int face=-1; vec3 exitNormal=vec3(0,0,1);
    for(int f=0;f<4;f++) {
      vec4 plane=fetchAt(uTets,tet*5+f);
      float denom=dot(plane.xyz,rd);
      if(denom<=1e-8 || (prevTet>=0 && int(neighbors[f])==prevTet)) continue;
      float t=-(dot(plane.xyz,ro)+plane.w)/denom;
      if(t>=current-.00008 && t<leave) {leave=max(t,current);face=f;exitNormal=plane.xyz;}
    }
    if(face<0) break;
    float a=max(current,clipNear),b=min(leave,clipFar);
    bool newHex=hex!=prevHex;
    vec4 cellProperties=fetchAt(uCells,hex*9+8);
    // An excluded cell contributes neither volume nor edges. Keep traversing
    // its topology so visible cells behind the new void remain reachable.
    if(b>a+1e-7 && matchesPorosity(cellProperties)) {
      bool sectionStart=a>current+EPS;
      if(hex!=colorHex || !visible) {
        float scalar=cellProperties[uProperty];
        vec3 normal=sectionStart?clipNormal:entryNormal;
        float lighting=.66+.34*max(0.0,dot(normal,normalize(vec3(-.3,-.5,.85))));
        color=ramp(scalar)*lighting;
        extinction=uDensity*(.8+.4*scalar);
        colorHex=hex;
      }
      if(uEdges==1 && (uInterior==1 || !visible) && (newHex || !visible)) gridLine(acc,ro+rd*a,hex,a,sectionStart,visible);
      // Exact homogeneous emission-absorption integral over this ray segment.
      // No uniform sample step and no interpolation between distinct cells.
      float alpha=1.0-exp(-extinction*(b-a));
      composite(acc,color,alpha);
      int next=int(neighbors[face]);
      bool exposed=next<0;
      if(!exposed && uPorosityFilter==1 && next/6!=hex) exposed=!matchesPorosity(fetchAt(uCells,(next/6)*9+8));
      if(uEdges==1 && uInterior==1 && (b<leave-EPS || exposed)) gridLine(acc,ro+rd*b,hex,b,b<leave-EPS,true);
      visible=true;
    }
    int nextTet=int(neighbors[face]);
    prevHex=hex; prevTet=tet; current=leave; entryNormal=-exitNormal;
    if(nextTet<0) {
      if(current>=clipFar || acc.a>.997) break;
      if(!findEntry(ro,rd,invDir,current+EPS,current,nextTet,entryNormal)) break;
      prevHex=-1; prevTet=-1;
    }
    tet=nextTet;
  }
  outColor=vec4(acc.rgb+(1.0-acc.a)*bg,1.0);
}`;
