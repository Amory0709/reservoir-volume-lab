import {compactSurfaceInput,buildSurfaceFaces,buildSectionCells} from './surface-cache.js';
let input,running=false;
const lanes=new Map();
const getLane=id=>{if(!lanes.has(id))lanes.set(id,{pending:null,revision:0,filterKey:null,cache:null});return lanes.get(id);};
async function pump(){
  if(running||!input)return;running=true;
  try{while(true){
    const entry=[...lanes].find(([,lane])=>lane.pending);if(!entry)break;
    const [id,lane]=entry,job=lane.pending;lane.pending=null;
    const cancelled=()=>job.revision!==lane.revision;
    try{
      if(job.filterKey!==lane.filterKey){
        // Immutable CPU masks/indices may be shared for identical filters.
        const shared=[...lanes.values()].find(other=>other.cache&&other.filterKey===job.filterKey);
        const next=shared?.cache??await buildSurfaceFaces(input,job.filterKey,cancelled);if(!next)continue;
        lane.cache=next;lane.filterKey=job.filterKey;
      }
      if(cancelled())continue;
      const section=await buildSectionCells(input,lane.cache.selected,job.axis,job.position,cancelled);
      if(!section||cancelled())continue;
      const faces=lane.cache.faces.slice(),caps=section.caps;
      self.postMessage({type:'surface',lane:id,key:job.key,faces,caps,groups:lane.cache.groups,faceCount:lane.cache.faceCount,cpuBytes:input.cpuBytes+lane.cache.selected.byteLength+lane.cache.faces.byteLength},[faces.buffer,caps.buffer]);
    }catch(error){self.postMessage({type:'error',lane:id,message:error.message});}
    finally{lanes.delete(id);lanes.set(id,lane);}
  }}finally{running=false;}
}
self.onmessage=async ({data})=>{
  if(data.type==='init'){
    try{input=await compactSurfaceInput(data.volume);self.postMessage({type:'initialized',cpuBytes:input.cpuBytes});pump();}
    catch(error){self.postMessage({type:'error',message:error.message});}
  }else if(data.type==='compare'){
    const original=lanes.get('default');
    for(const id of ['volume','surface'])Object.assign(getLane(id),{filterKey:original?.filterKey??null,cache:original?.cache??null});
    lanes.delete('default');
  }else if(data.type==='build'){
    const id=data.lane??'default';if(!['default','volume','surface'].includes(id))return;
    const lane=getLane(id);lane.pending={...data,revision:++lane.revision};pump();
  }
};
