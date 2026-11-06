// Worker-side, bounded boundary extraction. Coordinates/properties stay in GPU
// textures; the raster cache packs a cell id and its boundary-face mask.
const tick=()=>new Promise(r=>setTimeout(r,0));
export function surfaceFilterKey(s,v){
  const a=v.sortedPhi;
  const lo=Math.fround(s.porosityMin/100),hi=Math.fround(s.porosityMax/100);
  const all=a?.length===v.stats.activeCells&&(!a.length||(lo<=a[0]&&hi>=a[a.length-1]));
  return !s.porosityFilter||all?'all':`${lo}:${hi}`;
}
export function surfaceKey(s,v){return surfaceFilterKey(s,v)+'|'+(s.clipAxis?`${s.clipAxis}:${Math.fround(v.bounds.max[s.clipAxis-1]-(v.bounds.max[s.clipAxis-1]-v.bounds.min[s.clipAxis-1])*s.clip/100)}`:'none');}
export async function compactSurfaceInput(v,cancelled=()=>false){
  const count=v.dims.reduce((a,b)=>a*b,1),phi=new Float32Array(count),active=new Uint8Array(count);
  for(let start=0;start<count;start+=262144){
    if(cancelled())return null;
    for(let i=start,end=Math.min(count,start+262144);i<end;i++){phi[i]=v.attributes[i*4+1];active[i]=v.attributes[i*4+3]>.5?1:0;}
    await tick();
  }
  const groups=v.dims.map(n=>Math.ceil(n/2)),boxes=new Float32Array(groups.reduce((a,b)=>a*b,1)*6);
  for(let start=0;start<v.nodeCount;start+=262144){
    if(cancelled())return null;
    for(let n=start,end=Math.min(v.nodeCount,start+262144);n<end;n++){
      const o=n*8,leaf=v.nodes[o+7]-1;if(leaf<0)continue;
      for(let a=0;a<3;a++){boxes[leaf*6+a]=v.nodes[o+a];boxes[leaf*6+a+3]=v.nodes[o+a+4];}
    }
    await tick();
  }
  const result={dims:v.dims,splitsX:v.splitsX,splitY:v.splitY,columnPillars:v.columnPillars,kInterfaces:v.kInterfaces,phi,active,boxes,groups};
  result.cpuBytes=phi.byteLength+active.byteLength+boxes.byteLength+(v.columnPillars?.byteLength??0)+(v.kInterfaces?.byteLength??0);
  return result;
}
export function sharesSurfaceFace(v,i,j,k,face){
  const [nx,ny,nz]=v.dims;
  if(face===0)return k>0&&(!v.kInterfaces||v.kInterfaces[(k-1)*2+1]===v.kInterfaces[k*2]);
  if(face===1)return k+1<nz&&(!v.kInterfaces||v.kInterfaces[k*2+1]===v.kInterfaces[(k+1)*2]);
  if((face===2&&j===0)||(face===3&&j+1===ny)||(face===4&&i===0)||(face===5&&i+1===nx))return false;
  if(!v.columnPillars)return face<4?(face===2?j!==v.splitY:j+1!==v.splitY):!v.splitsX.includes(face===4?i:i+1);
  const p=v.columnPillars,o=(j*nx+i)*4;
  if(face===2){const n=o-nx*4;return p[o]===p[n+3]&&p[o+1]===p[n+2];}
  if(face===3){const n=o+nx*4;return p[o+3]===p[n]&&p[o+2]===p[n+1];}
  if(face===4){const n=o-4;return p[o]===p[n+1]&&p[o+3]===p[n+2];}
  return p[o+1]===p[o+4]&&p[o+2]===p[o+7];
}
function collector(limit){
  const chunks=[];let block=new Uint32Array(Math.min(65536,limit)),used=0,total=0;
  return {push(value){if(total===limit)throw new Error('表面索引超过网格单元数');if(used===block.length){chunks.push(block);block=new Uint32Array(Math.min(65536,limit-total));used=0;}block[used++]=value;total++;},finish(){const out=new Uint32Array(total);let offset=0;for(const c of chunks){out.set(c,offset);offset+=c.length;}out.set(block.subarray(0,used),offset);return out;}};
}
export async function buildSurfaceFaces(v,filterKey,cancelled=()=>false){
  const [nx,ny,nz]=v.dims,nxy=nx*ny,count=nxy*nz,selected=new Uint8Array(count),range=filterKey==='all'?null:filterKey.split(':').map(Number);
  for(let start=0;start<count;start+=262144){
    if(cancelled())return null;
    for(let id=start,end=Math.min(count,start+262144);id<end;id++)selected[id]=v.active[id]&&(!range||(v.phi[id]>=range[0]&&v.phi[id]<=range[1]))?1:0;
    await tick();
  }
  // Packed caches store a cell id and its six boundary bits once per cell.
  // Group by face count so rasterization submits only the real faces, with no
  // degenerate triangles. Even a fragmented 20M grid needs at most 80 MB of
  // boundary indices, instead of up to 480 MB of individual face codes.
  const groups=Array.from({length:6},()=>collector(count));
  const offsets=[-nxy,nxy,-nx,nx,-1,1];let faceCount=0;
  for(let start=0;start<count;start+=65536){
    if(cancelled())return null;
    for(let id=start,end=Math.min(count,start+65536);id<end;id++){
      if(!selected[id])continue;
      const i=id%nx,j=Math.floor(id/nx)%ny,k=Math.floor(id/nxy);
      let mask=0,n=0;
      for(let f=0;f<6;f++)if(!sharesSurfaceFace(v,i,j,k,f)||!selected[id+offsets[f]]){
        mask|=1<<f;n++;
      }
      if(n){groups[n-1].push(id*64+mask);faceCount+=n;}
    }
    await tick();
  }
  const parts=groups.map(g=>g.finish()),sizes=parts.map(p=>p.length),faces=new Uint32Array(sizes.reduce((a,b)=>a+b,0));
  let offset=0;for(const part of parts){faces.set(part,offset);offset+=part.length;}
  return {faces,groups:sizes,faceCount,selected};
}
export async function buildSectionCells(v,selected,axis,position,cancelled=()=>false){
  if(!axis)return {caps:new Uint32Array(0)};
  const a=axis-1,out=collector(selected.length),[nx,ny,nz]=v.dims,[gx,gy]=v.groups,leaves=v.boxes.length/6;
  for(let start=0;start<leaves;start+=65536){
    if(cancelled())return null;
    for(let leaf=start,end=Math.min(leaves,start+65536);leaf<end;leaf++){
      const o=leaf*6;if(v.boxes[o+a]>position||v.boxes[o+a+3]<position)continue;
      const x=(leaf%gx)*2,y=(Math.floor(leaf/gx)%gy)*2,z=Math.floor(leaf/(gx*gy))*2;
      for(let dz=0;dz<2;dz++)for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++){
        const i=x+dx,j=y+dy,k=z+dz,id=(k*ny+j)*nx+i;
        if(i<nx&&j<ny&&k<nz&&selected[id])out.push(id*8+6);
      }
    }
    await tick();
  }
  return {caps:out.finish()};
}
