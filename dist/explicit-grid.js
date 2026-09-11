/** Explicit Float32 XYZ geometry; IJK connectivity with split fault planes.
 * The GPU consumes these coordinates, never a formula for the deformation.
 * Faces use a consistent two-triangle representation; cells are not voxels.
 */
export const EXPLICIT_SCALES={'explicit-1m':[200,100,50],'explicit-10m':[400,250,100],'explicit-20m':[500,400,100]};
export const CORNERS=[[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]];
export const FACES=[[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[3,7,6],[3,6,2],[0,4,7],[0,7,3],[1,2,6],[1,6,5]];
export const EDGES=[[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
const clamp=x=>Math.max(0,Math.min(1,x));
function noise(i){let h=Math.imul(i+17,1597334677);h=Math.imul(h^(h>>>16),2246822519);return ((h^(h>>>13))>>>0)/4294967295-.5;}
function axis(n,span,seed){const a=new Float32Array(n+1);let s=0;for(let i=0;i<n;i++){s+=1+.19*Math.sin(i*1.73+seed)+.09*Math.cos(i*.61);a[i+1]=s;}for(let i=0;i<=n;i++)a[i]=(a[i]/s-.5)*span;return a;}
export function cornerOffset(v,i,j,k,c){
  if(v.columnPillars){const pillar=v.columnPillars[(j*v.dims[0]+i)*4+c%4],level=v.kInterfaces[k*2+(c>=4?1:0)];return ((level*v.nodeDims[1]+Math.floor(pillar/v.nodeDims[0]))*v.nodeDims[0]+pillar%v.nodeDims[0])*4;}
  const [dx,dy,dz]=CORNERS[c],sx=v.splitsX.reduce((n,s)=>n+(i>=s),0),sy=j>=v.splitY?1:0;
  return (((k+dz)*v.nodeDims[1]+j+sy+dy)*v.nodeDims[0]+i+sx+dx)*4;
}
export function buildExplicitBvh(v,progress=()=>{}){
  const [nx,ny,nz]=v.dims,g=v.dims.map(n=>Math.ceil(n/2)),leafCount=g[0]*g[1]*g[2],nodeCount=2*leafCount-1;
  // Float32 indices are exact here: max node index at 20M is < 2^24.
  if(nodeCount>=16777216)throw new Error('空间索引超过此版本的精确索引范围。');
  const width=2048,nodeHeight=Math.ceil(nodeCount*2/width),rangeHeight=Math.ceil(nodeCount/width);
  const nodes=new Float32Array(width*nodeHeight*4),ranges=new Float32Array(width*rangeHeight*2);
  const {vertices,attributes,nodeDims,splitsX,splitY}=v;let next=0,leaves=0,maxDepth=0;
  function build(x0,y0,z0,x1,y1,z1,depth){
    const id=next++,o=id*8,r=id*2;maxDepth=Math.max(maxDepth,depth);
    if(x1-x0===1&&y1-y0===1&&z1-z0===1){
      let lx=Infinity,ly=Infinity,lz=Infinity,hx=-Infinity,hy=-Infinity,hz=-Infinity,pmin=Infinity,pmax=-Infinity,hasActive=false;
      for(let dz=0;dz<2;dz++)for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++){
        const i=x0*2+dx,j=y0*2+dy,k=z0*2+dz,a=((k*ny+j)*nx+i)*4;
        if(i>=nx||j>=ny||k>=nz)continue;
        if(attributes[a+3]===0)continue;
        hasActive=true;
        if(Number.isFinite(attributes[a+1])){pmin=Math.min(pmin,attributes[a+1]);pmax=Math.max(pmax,attributes[a+1]);}
        if(v.columnPillars){
          for(let c=0;c<8;c++){const p=cornerOffset(v,i,j,k,c),x=vertices[p],y=vertices[p+1],z=vertices[p+2];lx=Math.min(lx,x);ly=Math.min(ly,y);lz=Math.min(lz,z);hx=Math.max(hx,x);hy=Math.max(hy,y);hz=Math.max(hz,z);}
          continue;
        }
        const ii=i+(i>=splitsX[0])+(i>=splitsX[1])+(i>=splitsX[2]),jj=j+(j>=splitY);
        for(let vk=0;vk<2;vk++)for(let vj=0;vj<2;vj++)for(let vi=0;vi<2;vi++){
          const p=(((k+vk)*nodeDims[1]+jj+vj)*nodeDims[0]+ii+vi)*4,x=vertices[p],y=vertices[p+1],z=vertices[p+2];
          lx=Math.min(lx,x);ly=Math.min(ly,y);lz=Math.min(lz,z);hx=Math.max(hx,x);hy=Math.max(hy,y);hz=Math.max(hz,z);
        }
      }
      if(!hasActive){lx=ly=lz=hx=hy=hz=0;pmin=1;pmax=-1;}
      else if(pmin>pmax){pmin=0;pmax=1;}
      nodes[o]=lx;nodes[o+1]=ly;nodes[o+2]=lz;nodes[o+4]=hx;nodes[o+5]=hy;nodes[o+6]=hz;
      nodes[o+7]=(z0*g[1]+y0)*g[0]+x0+1;ranges[r]=pmin;ranges[r+1]=pmax;
      if(++leaves%32768===0)progress(leaves/leafCount);
    }else{
      // Spatially balanced splits, including thin reservoir layers.
      const ex=(x1-x0)*6.2/nx,ey=(y1-y0)*3.7/ny,ez=(z1-z0)*1.4/nz;
      let left,right;
      if(x1-x0>1&&(ex>=ey||y1-y0===1)&&(ex>=ez||z1-z0===1)){
        const m=(x0+x1)>>1;left=build(x0,y0,z0,m,y1,z1,depth+1);right=build(m,y0,z0,x1,y1,z1,depth+1);
      }else if(y1-y0>1&&(ey>=ez||z1-z0===1)){
        const m=(y0+y1)>>1;left=build(x0,y0,z0,x1,m,z1,depth+1);right=build(x0,m,z0,x1,y1,z1,depth+1);
      }else{const m=(z0+z1)>>1;left=build(x0,y0,z0,x1,y1,m,depth+1);right=build(x0,y0,m,x1,y1,z1,depth+1);}
      const validLeft=ranges[left*2]<=ranges[left*2+1],validRight=ranges[right*2]<=ranges[right*2+1];
      for(let c=0;c<3;c++){
        nodes[o+c]=validLeft&&validRight?Math.min(nodes[left*8+c],nodes[right*8+c]):nodes[(validLeft?left:right)*8+c];
        nodes[o+4+c]=validLeft&&validRight?Math.max(nodes[left*8+4+c],nodes[right*8+4+c]):nodes[(validLeft?left:right)*8+4+c];
      }
      ranges[r]=Math.min(ranges[left*2],ranges[right*2]);ranges[r+1]=Math.max(ranges[left*2+1],ranges[right*2+1]);
    }
    nodes[o+3]=next;return id;
  }
  build(0,0,0,...g,0);if(next!==nodeCount||maxDepth>=32)throw new Error('空间索引构建失败。');
  Object.assign(v,{nodes,ranges,nodeWidth:width,nodeHeight,rangeHeight,nodeCount,groups:g,bounds:{min:Array.from(nodes.slice(0,3)),max:Array.from(nodes.slice(4,7))}});
  v.stats.bvhNodes=nodeCount;v.stats.bvhDepth=maxDepth;
}
export function makeExplicitGrid(scale='explicit-10m',progress=()=>{},customDims){
  const start=performance.now(),dims=customDims??EXPLICIT_SCALES[scale];
  if(!dims||dims.some(n=>n%2)||dims[0]<4)throw new Error('不支持的网格尺寸。');
  const [nx,ny,nz]=dims,count=nx*ny*nz,splitsX=[Math.floor(nx/4),Math.floor(nx/2),Math.floor(nx*3/4)],splitY=ny/2,nodeDims=[nx+4,ny+2,nz+1];
  const axes=[axis(nx,6.2,1),axis(ny,3.7,5),axis(nz,1.4,9)],vertices=new Float32Array(nodeDims.reduce((a,b)=>a*b,1)*4);
  const cutsX=[0,...splitsX,nx],cutsY=[0,splitY,ny];
  for(let by=0;by<2;by++)for(let bx=0;bx<4;bx++){
    for(let k=0;k<=nz;k++)for(let j=cutsY[by];j<=cutsY[by+1];j++)for(let i=cutsX[bx];i<=cutsX[bx+1];i++){
      const p=((k*nodeDims[1]+j+by)*nodeDims[0]+i+bx)*4,x=axes[0][i],y=axes[1][j],z=axes[2][k];
      vertices[p]=x+.08*z+.018*Math.sin(y*2.1+z*2)+(bx-1.5)*.075+noise(p)*.03*6.2/nx;
      vertices[p+1]=y+.045*z+.012*Math.sin(x*1.8-z*2)+(by-.5)*.085+noise(p+1)*.03*3.7/ny;
      vertices[p+2]=z+.24*Math.sin(x*.95)+.16*Math.cos(y*1.3)+.035*Math.sin(x*y+z*3)-.12*bx+.16*by+.045*bx*z+noise(p+2)*.04*1.4/nz;
      vertices[p+3]=1;
    }
    progress(.25*(by*4+bx+1)/8,'写入 XYZ 角点');
  }
  const attributes=new Float32Array(count*4),sortedPhi=new Float32Array(count);let active=0;
  const channel=new Float32Array(nx*ny),lateral=new Float32Array(nx*ny),footprint=new Uint8Array(nx*ny);
  for(let j=0;j<ny;j++)for(let i=0;i<nx;i++){
    const u=(i+.5)/nx*2-1,v=(j+.5)/ny*2-1,h=j*nx+i;
    channel[h]=Math.exp(-((v-.28*Math.sin(u*4.3)-.06)**2)/.07);lateral[h]=.08*Math.sin(u*3.1+v*2.3);
    footprint[h]=u*u*.58+v*v*.66<.93+.06*Math.sin(u*7+v*5)?1:0;
  }
  for(let k=0;k<nz;k++){
    const z=(k+.5)/nz,layer=.10*Math.sin(z*14),lk=.11*Math.sin(z*9.5);
    for(let j=0;j<ny;j++)for(let i=0;i<nx;i++){
      const h=j*nx+i,id=k*nx*ny+h,o=id*4,c=channel[h],n=noise(id)*.10;
      const lens=z>.43&&z<.47&&c<.5&&i>nx*.18&&i<nx*.82;
      attributes[o]=.05+.80*clamp(.14+.67*z+.10*c+lateral[h]+n);
      attributes[o+1]=.08+.24*clamp(.24+.45*c+layer+lateral[h]*.4+n);
      attributes[o+2]=.5*Math.pow(3000,clamp(.12+.68*c+lk+n*1.3));
      attributes[o+3]=footprint[h]&&!lens?1:0;
      if(attributes[o+3])sortedPhi[active++]=attributes[o+1];
    }
    progress(.25+.3*(k+1)/nz,'写入 Float32 属性与非活动单元');
  }
  const v={kind:'explicit',scale,dims:[...dims],nodeDims,splitsX,splitY,vertices,attributes,sortedPhi:sortedPhi.subarray(0,active),synthetic:true,stats:{cells:count,activeCells:active,inactiveCells:count-active,vertices:vertices.length/4,propertyBytes:attributes.byteLength}};
  buildExplicitBvh(v,f=>progress(.55+.35*f,'建立空间索引'));
  progress(.91,'排序孔隙度精确计数索引');v.sortedPhi.sort();
  v.stats.gpuBytes=vertices.byteLength+attributes.byteLength+v.nodes.byteLength+v.ranges.byteLength;
  v.stats.cpuIndexBytes=sortedPhi.byteLength;v.stats.generationMs=performance.now()-start;
  progress(1,'准备上传');return v;
}
export function explicitPorosityRange(lo,hi){return [Math.fround(lo/100),Math.fround(hi/100)];}
export function countExplicitMatches(v,s){
  if(!s.porosityFilter)return v.stats.activeCells;
  const a=v.sortedPhi,[min,max]=explicitPorosityRange(s.porosityMin,s.porosityMax);
  function bound(value,upper){let lo=0,hi=a.length;while(lo<hi){const m=(lo+hi)>>>1;if(a[m]<value||(upper&&a[m]===value))lo=m+1;else hi=m;}return lo;}
  return bound(max,true)-bound(min,false);
}
