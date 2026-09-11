import assert from 'node:assert/strict';
import {createSyntheticGrid,buildVolumeData,sub,cross,dot,normalize,scale,add} from './dist/mesh.js';

const volume=buildVolumeData(createSyntheticGrid()),{tets,triangles,stats}=volume;
const planes=volume.tetraTexture.data;
for(let id=0;id<tets.length;id++) for(let face=0;face<4;face++) {
  const twin=tets[id].neighbors[face];
  if(twin>=0) assert(tets[twin].neighbors.includes(id),'Non-reciprocal adjacency');
}
// Independent all-tetra ray intersection: reference for the adjacency walk.
function brute(ro,rd) {
  let total=0,hits=0;
  for(let id=0;id<tets.length;id++) {
    let near=0,far=1e20;
    for(let face=0;face<4;face++) {
      const o=id*20+face*4;
      const a=planes[o],b=planes[o+1],c=planes[o+2],d=planes[o+3];
      const denom=a*rd[0]+b*rd[1]+c*rd[2],side=a*ro[0]+b*ro[1]+c*ro[2]+d;
      if(Math.abs(denom)<1e-12) {if(side>0){far=-1;break;}continue;}
      const t=-side/denom;
      if(denom>0)far=Math.min(far,t);else near=Math.max(near,t);
      if(far<near)break;
    }
    if(far>near+1e-7){total+=far-near;hits++;}
  }
  return {total,hits};
}
function entry(ro,rd,lower) {
  let best=1e20,id=-1;
  for(const tr of triangles) {
    const [a,b,c]=tr.p,e1=sub(b,a),e2=sub(c,a),p=cross(rd,e2),det=dot(e1,p);
    if(det<1e-8)continue;
    const s=sub(ro,a),u=dot(s,p)/det;if(u < -1e-6 || u>1.000001)continue;
    const q=cross(s,e1),v=dot(rd,q)/det;if(v < -1e-6 || u+v>1.000001)continue;
    const t=dot(e2,q)/det;if(t>lower && t<best){best=t;id=tr.tet;}
  }
  return {t:best,id};
}
function walk(ro,rd) {
  let hit=entry(ro,rd,0),id=hit.id,current=hit.t,previous=-1,total=0,components=id<0?0:1,steps=0;
  for(;steps<640 && id>=0;steps++) {
    let leave=1e20,exit=-1;
    for(let f=0;f<4;f++) {
      const o=id*20+f*4;
      const denom=planes[o]*rd[0]+planes[o+1]*rd[1]+planes[o+2]*rd[2];
      if(denom<=1e-8 || previous>=0 && tets[id].neighbors[f]===previous)continue;
      const t=-(planes[o]*ro[0]+planes[o+1]*ro[1]+planes[o+2]*ro[2]+planes[o+3])/denom;
      if(t>=current-.00008 && t<leave){leave=Math.max(current,t);exit=f;}
    }
    assert(exit>=0,'Traversal lost an exit face');
    total+=leave-current;
    previous=id;id=tets[id].neighbors[exit];current=leave;
    if(id<0) {hit=entry(ro,rd,current+.000008);id=hit.id;current=hit.t;previous=-1;if(id>=0)components++;}
  }
  assert(steps<640,'Traversal budget exhausted');
  return {total,components,steps};
}
let seed=49231;const random=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/4294967296;};
const origins=[[7,-8,6],[.013,-.037,10],[.017,-10,.11],[-7,8,-5]];
let maxError=0,maxSteps=0,multiComponent=0,rayCount=0;
for(const ro of origins) {
  for(let sample=0;sample<72;sample++) {
    const target=[(random()-.5)*7,(random()-.5)*4.6,(random()-.5)*2.8];
    const rd=normalize(sub(target,ro));
    const actual=walk(ro,rd),expected=brute(ro,rd);
    const error=Math.abs(actual.total-expected.total);maxError=Math.max(maxError,error);maxSteps=Math.max(maxSteps,actual.steps);
    assert(error<.001,JSON.stringify({ro,rd,actual,expected,error}));
    if(actual.components>1)multiComponent++;
    rayCount++;
  }
}
assert(multiComponent>5,'Re-entry across disconnected regions was not exercised');
console.log(JSON.stringify({result:'PASS',...stats,checkedRays:rayCount,maxRayLengthError:maxError,maxTraversalSteps:maxSteps,raysWithReentry:multiComponent},null,2));
