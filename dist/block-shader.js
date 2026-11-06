// Exact leaf/cell intersections inside conservative bins. All blocks share the
// same front-to-back accumulator in the original shader's main traversal.
export const blockDeclarations=`
uniform sampler2D uBlockData;
uniform highp usampler2D uBinRanges,uBinLeaves;
uniform int uBlockCount,uBlockTraversal;
vec4 blockRecord(int block,int record){return texelFetch(uBlockData,ivec2(block*4+record,0),0);}
`;
export const blockSearch=`
bool findBlockCell(vec3 ro,vec3 rd,vec3 inv,float lower,float upper,out ivec3 cell,out float a,out float b,out vec3 normal,out int face){
 a=INF;bool found=false;
 for(int block=0;block<uBlockCount;block++){
  vec4 low=blockRecord(block,0),high=blockRecord(block,1);vec2 phi=blockRecord(block,3).xy;
  if(uPorosityFilter==1&&(phi.y<uPhi.x||phi.x>uPhi.y))continue;
  vec3 ts0=(low.xyz-ro)*inv,ts1=(high.xyz-ro)*inv;
  vec3 near3=min(ts0,ts1),far3=max(ts0,ts1);
  float begin=max(lower,max(near3.x,max(near3.y,near3.z))),end=min(min(upper,a),min(far3.x,min(far3.y,far3.z)));
  if(end<begin)continue;
  ivec3 dims=ivec3(blockRecord(block,2).xyz),directionStep=ivec3(sign(rd));
  vec3 spacing=(high.xyz-low.xyz)/vec3(dims);
  ivec3 bin=clamp(ivec3(floor((ro+rd*begin-low.xyz)/spacing)),ivec3(0),dims-ivec3(1));
  vec3 boundary=low.xyz+(vec3(bin)+step(vec3(0),rd))*spacing;
  vec3 crossing=(boundary-ro)*inv,delta=abs(spacing*inv);
  if(abs(rd.x)<1e-12)crossing.x=INF;if(abs(rd.y)<1e-12)crossing.y=INF;if(abs(rd.z)<1e-12)crossing.z=INF;
  for(int visit=0;visit<dims.x+dims.y+dims.z+3;visit++){
   float leave=min(end,min(crossing.x,min(crossing.y,crossing.z)));
   int id=int(low.w)+(bin.z*dims.y+bin.y)*dims.x+bin.x;
   uvec2 range=texelFetch(uBinRanges,ivec2(id%2048,id/2048),0).rg;
   for(uint ref=range.x;ref<range.x+range.y;ref++){
    int nodeId=int(texelFetch(uBinLeaves,ivec2(int(ref)%2048,int(ref)/2048),0).r);
    if(nodeNear(nodeId,ro,inv,begin,min(leave+EPS,a))>=INF)continue;
    int leaf=int(node(nodeId*2+1).w)-1;ivec3 g=(uDimensions+ivec3(1))/2;
    ivec3 base=ivec3(leaf%g.x,(leaf/g.x)%g.y,leaf/(g.x*g.y))*2;
    for(int i=0;i<8;i++){
     ivec3 candidate=base+ivec3(i&1,(i>>1)&1,(i>>2)&1);
     if(!valid(candidate)||!matches(texelFetch(uAttributes,candidate,0)))continue;
     float ca,cb;vec3 cn;int cf;
     if(cellInterval(candidate,ro,rd,lower,upper,ca,cb,cn,cf)&&ca<a&&cb>begin-EPS&&ca<=leave+EPS){found=true;cell=candidate;a=ca;b=cb;normal=cn;face=cf;}
    }
   }
   if(a<=leave+EPS||leave>=end)break;
   float next=min(crossing.x,min(crossing.y,crossing.z));
   // Advance tied planes together; no epsilon that could skip a thin bin.
   for(int axis=0;axis<3;axis++)if(crossing[axis]<=next){bin[axis]+=directionStep[axis];crossing[axis]+=delta[axis];}
   if(any(lessThan(bin,ivec3(0)))||any(greaterThanEqual(bin,dims)))break;
   begin=next;
  }
 }
 return found;
}
`;
export function withBlockTraversal(source){
 return source.replace('void main(){',blockDeclarations+blockSearch+'\nvoid main(){')
  .replaceAll('bool found=findCell(', 'bool found=searchCell(')
  .replaceAll('found=findCell(', 'found=searchCell(')
  .replace('\nvoid main(){',`\nbool searchCell(vec3 ro,vec3 rd,vec3 inv,float lower,float upper,out ivec3 cell,out float a,out float b,out vec3 normal,out int face){
   if(uBlockTraversal==1&&uBlockCount>0)return findBlockCell(ro,rd,inv,lower,upper,cell,a,b,normal,face);
   return findCell(ro,rd,inv,lower,upper,cell,a,b,normal,face);
  }\nvoid main(){`);
}
