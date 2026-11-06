import {explicitFragmentShader} from './explicit-shaders.js';
import {CORNERS,FACES} from './explicit-grid.js';
const table=(name,rows)=>`const ivec3 ${name}[${rows.length}]=ivec3[${rows.length}](${rows.map(r=>`ivec3(${r.join(',')})`).join(',')});`;
export const surfaceVertexShader=`#version 300 es
precision highp float;
precision highp int;
precision highp sampler3D;
precision highp usampler2D;
layout(location=0) in uint aFace;
uniform sampler3D uVertices;
uniform usampler2D uColumnPillars,uKInterfaces;
uniform ivec3 uDimensions,uSplits;
uniform int uImported,uClipAxis,uPacked;
uniform float uClipPosition,uTanFov;
uniform vec2 uResolution;
uniform vec3 uEye,uForward,uRight,uUp;
flat out int fCell;
flat out int fSection;
out vec3 fWorld;
${table('CORNERS',CORNERS)}
${table('TRIANGLES',FACES)}
const ivec2 QUAD[6]=ivec2[6](ivec2(0,0),ivec2(1,0),ivec2(1,1),ivec2(0,0),ivec2(1,1),ivec2(0,1));
vec3 pointAt(ivec3 c,int corner){
  if(uImported==1){
    uvec4 pillars=texelFetch(uColumnPillars,c.xy,0);uvec2 levels=texelFetch(uKInterfaces,ivec2(c.z,0),0).rg;
    int p=int(pillars[corner%4]),w=textureSize(uVertices,0).x;
    return texelFetch(uVertices,ivec3(p%w,p/w,int(levels[corner/4])),0).xyz;
  }
  int bx=int(c.x>=uSplits.x)+int(c.x>=uSplits.y)+int(c.x>=uSplits.z);
  return texelFetch(uVertices,c+ivec3(bx,int(c.y>=uDimensions.y/2),0)+CORNERS[corner],0).xyz;
}
void main(){
  int face,vertex=gl_VertexID%6;
  if(uPacked==1){
    fCell=int(aFace>>6u);uint mask=aFace&63u;int ordinal=gl_VertexID/6;face=0;
    for(int f=0;f<6;f++)if((mask&(1u<<uint(f)))!=0u){if(ordinal==0){face=f;break;}ordinal--;}
  }else{int code=int(aFace);face=code%8;fCell=code/8;}
  fSection=face==6?1:0;
  ivec3 cell=ivec3(fCell%uDimensions.x,(fCell/uDimensions.x)%uDimensions.y,fCell/(uDimensions.x*uDimensions.y));
  if(face<6)fWorld=pointAt(cell,TRIANGLES[face*2+vertex/3][vertex%3]);
  else{
    vec3 lo=vec3(1e25),hi=vec3(-1e25);
    for(int c=0;c<8;c++){vec3 p=pointAt(cell,c);lo=min(lo,p);hi=max(hi,p);}
    int a=uClipAxis-1;
    if(a<0||lo[a]>uClipPosition||hi[a]<uClipPosition){gl_Position=vec4(2,2,2,1);fWorld=vec3(0);return;}
    int b=(a+1)%3,c=(a+2)%3;ivec2 q=QUAD[vertex];
    fWorld=lo;fWorld[a]=uClipPosition;fWorld[b]=q.x==0?lo[b]:hi[b];fWorld[c]=q.y==0?lo[c]:hi[c];
  }
  // Reverse-Z with a floating-point depth buffer preserves thin distant cells.
  vec3 p=fWorld-uEye;float z=dot(p,uForward),near=.0001;
  gl_Position=vec4(dot(p,uRight)/(uTanFov*uResolution.x/uResolution.y),dot(p,uUp)/uTanFov,2.0*near-z,z);
}`;
// Share the exact scalar, corner and edge semantics with the volume shader.
// No BVH traversal is included in this raster fragment program.
const prefix=explicitFragmentShader.slice(0,explicitFragmentShader.indexOf('// Outward-wound'));
const interval=explicitFragmentShader.slice(explicitFragmentShader.indexOf('// Outward-wound'),explicitFragmentShader.indexOf('float nodeNear'));
const lines=explicitFragmentShader.slice(explicitFragmentShader.indexOf('float segmentDistance'),explicitFragmentShader.indexOf('bool connected('));
export const surfaceFragmentShader=prefix+interval+lines+`
flat in int fCell;
flat in int fSection;
in vec3 fWorld;
void main(){
  vec3 normal=normalize(cross(dFdx(fWorld),dFdy(fWorld)));
  ivec3 cell=ivec3(fCell%uDimensions.x,(fCell/uDimensions.x)%uDimensions.y,fCell/(uDimensions.x*uDimensions.y));
  vec4 property=texelFetch(uAttributes,cell,0);if(!matches(property))discard;
  if(uClipAxis>0&&fSection==0&&fWorld[uClipAxis-1]>uClipPosition)discard;
  vec3 delta=fWorld-uEye;float t=length(delta);vec3 rd=delta/max(t,1e-12);
  if(fSection==1){
    float a,b;vec3 n;int face;
    if(!cellInterval(cell,uEye,rd,t,INF,a,b,n,face)||a>t+EPS*2.0)discard;
    normal=vec3(0);normal[uClipAxis-1]=1.0;
  }else if(uEdges==1)corners(cell);
  vec4 acc=vec4(0);
  if(uEdges==1)gridLine(acc,fWorld,t,false,fSection==1);
  float edgeAlpha=acc.a;
  composite(acc,propertyColor(property)*(.78+.22*abs(dot(normal,normalize(vec3(.4,-.6,.8))))),1.0);
  outColor=vec4(acc.rgb,1);
}`;
export const surfaceBackgroundShader=prefix+`
void main(){
  vec2 xy=(gl_FragCoord.xy*2.0-uResolution)/uResolution.y;
  vec3 rd=normalize(uForward+uTanFov*(xy.x*uRight+xy.y*uUp));
  outColor=vec4(background(uEye,rd,vec3(0)),1);
}`;

// Accumulate color and optical depth separately. Every exposed layer can
// contribute without sorting millions of faces on each camera movement.
export const surfaceTransparentFragmentShader=surfaceFragmentShader
  .replace('out vec4 outColor;',`layout(location=0) out vec4 outColor;
layout(location=1) out vec4 outOpticalDepth;
uniform float uSurfaceOpacity;`)
  .replace('outColor=vec4(acc.rgb,1);',`
  // Fade the colored skin while keeping the original cell lines readable.
  float alpha=clamp(uSurfaceOpacity+(1.0-uSurfaceOpacity)*edgeAlpha,0.0,.9999);
  float weight=clamp(1.0/(.01+t*t),.01,1.0);
  outColor=vec4(acc.rgb*alpha*weight,alpha*weight);
  outOpticalDepth=vec4(-log(max(1.0-alpha,1e-4)),0,0,0);`);

export const surfaceResolveShader=prefix+`
uniform sampler2D uSurfaceAccum,uSurfaceDepth;
void main(){
  ivec2 pixel=ivec2(gl_FragCoord.xy);
  vec4 sum=texelFetch(uSurfaceAccum,pixel,0);
  float transmission=exp(-min(texelFetch(uSurfaceDepth,pixel,0).r,80.0));
  vec2 xy=(gl_FragCoord.xy*2.0-uResolution)/uResolution.y;
  vec3 rd=normalize(uForward+uTanFov*(xy.x*uRight+xy.y*uUp));
  vec3 bg=background(uEye,rd,vec3(0));
  vec3 color=sum.rgb/max(sum.a,1e-6);
  outColor=vec4(mix(color,bg,transmission),1);
}`;
