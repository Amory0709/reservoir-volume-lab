import {readFile,writeFile,mkdir} from 'node:fs/promises';
import * as shaders from '../dist/webgpu-shaders.js';
import {frameValues,gridLayoutEntries} from '../dist/webgpu-resources.js';
const [fixture,out]=process.argv.slice(2);await mkdir(out,{recursive:true});
for(const [key,source] of Object.entries(shaders))if(typeof source==='string')await writeFile(out+'/'+key+'.wgsl',source);
const volume=JSON.parse(await readFile(fixture+'/metadata.json','utf8'));
const camera=(az=-.87,el=.52,distance=10.2,target=[0,0,-.05])=>{
 const eye=[Math.cos(el)*Math.cos(az),Math.cos(el)*Math.sin(az),Math.sin(el)].map((v,i)=>v*distance+target[i]);
 const norm=a=>{let n=Math.hypot(...a);return a.map(v=>v/n);},cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
 const forward=norm(target.map((v,i)=>v-eye[i])),right=norm(cross(forward,[0,0,1])),up=cross(right,forward);return {eye,forward,right,up};
};
const cases=[];
for(const lightMode of [false,true])for(const args of [
 {},{density:100},{density:100,edges:false},{density:100,axis:3,clip:38},{density:100,filter_enabled:true,phi_min:18,phi_max:25},{density:99},{edges:false},{density:15},{axis:1,clip:38},{axis:2,clip:38},{axis:3,clip:38},{prop:1},{prop:2},
 {filter_enabled:true,phi_min:24},{filter_enabled:true,phi_min:24,axis:1,clip:38},{no_matches:true},
 {surface:true,axis:3,clip:38},{surface:true,edges:false},{surface:true,filter_enabled:true,phi_min:18,phi_max:25}
]){
 const settings={density:args.density??60,edges:args.edges??true,clipAxis:args.axis??0,clip:args.clip??0,property:args.prop??0,lineWidth:1.2,interior:true,porosityFilter:args.filter_enabled??false,porosityMin:args.phi_min??8,porosityMax:args.phi_max??32,lightMode};
 const values=frameValues(volume,settings,camera(),{width:96,height:72},1,args.no_matches??false,args.surface??false);
 const buffer=new ArrayBuffer(224),floats=new Float32Array(buffer),uints=new Uint32Array(buffer),ints=new Int32Array(buffer);
 shaders.webgpuUniformFields.forEach((key,i)=>(['dimensions','counts','flags','style','tile'].includes(key)?uints:key==='splits'?ints:floats).set(values[key],i*4));
 const index=cases.length;await writeFile(out+`/frame-${index}.bin`,new Uint8Array(buffer));cases.push({index,args,lightMode});
}
await writeFile(out+'/cases.json',JSON.stringify(cases));await writeFile(out+'/grid-layout.json',JSON.stringify(gridLayoutEntries()));
if(process.argv[4]){
 const surfaceCases=[];const cache=JSON.parse(await readFile(process.argv[4]+'/cases.json','utf8'));
 for(const lightMode of [false,true])for(const [az,el] of [[-.87,.52],[2.3,.4]])for(const [name,settings] of cache)for(const [property,edges] of [[0,true],[1,false],[2,true]]){
  const s={density:60,lineWidth:1.2,interior:true,lightMode,...settings,property,edges};
  const values=frameValues(volume,s,camera(az,el),{width:96,height:72},1,false,true);
  const buffer=new ArrayBuffer(224),floats=new Float32Array(buffer),uints=new Uint32Array(buffer),ints=new Int32Array(buffer);
  shaders.webgpuUniformFields.forEach((key,i)=>(['dimensions','counts','flags','style','tile'].includes(key)?uints:key==='splits'?ints:floats).set(values[key],i*4));
  const index=surfaceCases.length;await writeFile(out+`/surface-frame-${index}.bin`,new Uint8Array(buffer));
  surfaceCases.push({index,name,settings:s,az,el});
 }
 await writeFile(out+'/surface-cases.json',JSON.stringify(surfaceCases));
}
