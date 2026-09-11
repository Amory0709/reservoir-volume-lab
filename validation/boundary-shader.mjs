/** Instrument the production intersection kernel, without changing its math. */
export function boundaryShader(source){return source.slice(0,source.indexOf('\nvoid main(){'))+`
uniform sampler2D uTestRays;
uniform ivec3 uTestCell;
void main(){
  vec3 rd=texelFetch(uTestRays,ivec2(gl_FragCoord.xy),0).xyz;
  float a,b;vec3 normal;int face;
  bool hit=cellInterval(uTestCell,uEye,rd,0.0,INF,a,b,normal,face);
  vec3 lo=v[0],hi=v[0];
  for(int i=1;i<8;i++){lo=min(lo,v[i]);hi=max(hi,v[i]);}
  vec3 t0=(lo-uEye)/rd,t1=(hi-uEye)/rd,near=min(t0,t1);
  float bound=max(0.0,max(near.x,max(near.y,near.z)));
  outColor=hit?(a<bound-.00005?vec4(1,0,0,1):vec4(0,1,0,1)):vec4(0,0,1,1);
}`;}
