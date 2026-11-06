// Conservative spatial bins over the existing 2x2x2 geometry leaves. A bin
// contains every overlapping leaf, so neither thin cells nor faults are sampled
// away. Geometry stays in the original textures. Built once, independent of view.
export function buildBlockIndex(v,progress=()=>{},factor=1){
  const started=performance.now(),[nx,ny,nz]=v.dims,g=v.dims.map(n=>Math.ceil(n/2));
  let xs=[0,...v.splitsX,nx],ys=[0,v.splitY,ny],zs=[0,nz];
  if(v.columnPillars){
    const p=v.columnPillars;xs=[0];ys=[0];zs=[0];
    for(let i=1;i<nx;i++)for(let j=0;j<ny;j++){const a=(j*nx+i-1)*4,b=a+4;if(p[a+1]!==p[b]||p[a+2]!==p[b+3]){xs.push(i);break;}}
    for(let j=1;j<ny;j++)for(let i=0;i<nx;i++){const a=((j-1)*nx+i)*4,b=a+nx*4;if(p[a+3]!==p[b]||p[a+2]!==p[b+1]){ys.push(j);break;}}
    for(let k=1;k<nz;k++)if(v.kInterfaces[(k-1)*2+1]!==v.kInterfaces[k*2])zs.push(k);
    xs.push(nx);ys.push(ny);zs.push(nz);
  }
  // Complex fault networks remain valid with a global bin grid; no truncation.
  if((xs.length-1)*(ys.length-1)*(zs.length-1)>128){xs=[0,nx];ys=[0,ny];zs=[0,nz];}
  const partition=(n,cuts)=>{const a=new Uint16Array(n);for(let s=0;s<cuts.length-1;s++)a.fill(s,cuts[s],cuts[s+1]);return a;};
  const xp=partition(nx,xs),yp=partition(ny,ys),zp=partition(nz,zs),bx=xs.length-1,by=ys.length-1;
  const blocks=Array.from({length:bx*by*(zs.length-1)},()=>({lo:[Infinity,Infinity,Infinity],hi:[-Infinity,-Infinity,-Infinity],leaves:[],min:Infinity,max:-Infinity}));
  for(let node=0;node<v.nodeCount;node++){
    const o=node*8,leaf=v.nodes[o+7]-1;if(leaf<0||v.ranges[node*2]>v.ranges[node*2+1])continue;
    const i=leaf%g[0]*2,j=Math.floor(leaf/g[0])%g[1]*2,k=Math.floor(leaf/(g[0]*g[1]))*2;
    const block=blocks[(zp[k]*by+yp[j])*bx+xp[i]];block.leaves.push(node);
    for(let a=0;a<3;a++){block.lo[a]=Math.min(block.lo[a],v.nodes[o+a]);block.hi[a]=Math.max(block.hi[a],v.nodes[o+4+a]);}
    block.min=Math.min(block.min,v.ranges[node*2]);block.max=Math.max(block.max,v.ranges[node*2+1]);
  }
  const live=blocks.filter(b=>b.leaves.length),domain=v.bounds.max.map((x,a)=>x-v.bounds.min[a]);
  let bins=0;
  for(const block of live){
    // Round outwards in stored Float32 so CPU and GPU agree at every boundary.
    block.lo=block.lo.map(x=>Math.fround(x-1e-5));block.hi=block.hi.map(x=>Math.fround(x+1e-5));
    block.dims=block.lo.map((x,a)=>Math.max(1,Math.ceil((block.hi[a]-x)/(domain[a]/g[a]*factor))));
    block.offset=bins;bins+=block.dims.reduce((a,b)=>a*b,1);
  }
  if(!live.length||bins>=16777216||bins*8>160000000)return null;
  const width=2048,ranges=new Uint32Array(Math.ceil(bins/width)*width*2);
  const visit=(block,node,fn)=>{
    const o=node*8,low=[],high=[];
    for(let a=0;a<3;a++){
      const scale=block.dims[a]/(block.hi[a]-block.lo[a]);
      low[a]=Math.max(0,Math.floor((v.nodes[o+a]-block.lo[a])*scale-1e-4));
      high[a]=Math.min(block.dims[a]-1,Math.floor((v.nodes[o+4+a]-block.lo[a])*scale+1e-4));
    }
    for(let z=low[2];z<=high[2];z++)for(let y=low[1];y<=high[1];y++)for(let x=low[0];x<=high[0];x++)fn(block.offset+(z*block.dims[1]+y)*block.dims[0]+x);
  };
  for(const block of live)for(const node of block.leaves)visit(block,node,id=>ranges[id*2+1]++);
  let refs=0;for(let i=0;i<bins;i++){ranges[i*2]=refs;refs+=ranges[i*2+1];}
  if(refs>40000000||ranges.byteLength+refs*4>200000000)return null;
  const leaves=new Uint32Array(Math.max(width,Math.ceil(refs/width)*width)),cursor=new Uint32Array(bins);
  for(let bi=0;bi<live.length;bi++){
    const block=live[bi];for(const node of block.leaves)visit(block,node,id=>{leaves[ranges[id*2]+cursor[id]++]=node;});
    progress((bi+1)/live.length);
  }
  const data=new Float32Array(128*16);
  live.forEach((b,i)=>{data.set([...b.lo,b.offset,...b.hi,0,...b.dims,0,b.min,b.max,0,0],i*16);});
  return {data,ranges,leaves,count:live.length,width,bytes:data.byteLength+ranges.byteLength+leaves.byteLength,buildMs:performance.now()-started};
}
export function attachBlockIndex(v,progress=()=>{}){
  try{v.blockIndex=buildBlockIndex(v,progress);}
  catch(error){v.blockIndex=null;v.stats.blockIndexError=error.message;}
  v.stats.blockCount=v.blockIndex?.count??0;
  v.stats.blockIndexBytes=v.blockIndex?.bytes??0;
  v.stats.blockIndexMs=v.blockIndex?.buildMs??0;
}
export function blockIndexTransfers(v){return v.blockIndex?['data','ranges','leaves'].map(key=>v.blockIndex[key].buffer):[];}
