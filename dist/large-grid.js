/** Compact, explicit cell properties on a nonuniform layered grid. No mesh LOD. */
export const LARGE_SCALES={
  '1m':[200,100,50], '10m':[400,250,100], '20m':[500,400,100]
};
export const BRICK=10;
export const SHEAR=[.11,.055];
const clamp=x=>Math.max(0,Math.min(1,x));
function axis(n,span,seed){
  const a=new Float32Array(n+1);let sum=0;
  for(let i=0;i<n;i++){sum+=1+.21*Math.sin(i*1.73+seed)+.12*Math.cos(i*.61+seed);a[i+1]=sum;}
  for(let i=0;i<=n;i++)a[i]=(a[i]/sum-.5)*span;
  return a;
}
export function makeLargeGrid(scale='10m',progress=()=>{}) {
  const dims=LARGE_SCALES[scale];if(!dims)throw new Error('未知网格规模。');
  const [nx,ny,nz]=dims,split=nx/2;
  const axes=[axis(nx,6.2,1),axis(ny,3.7,5),axis(nz,1.4,9)];
  const coarse=dims.map(n=>n/BRICK),[bx,by,bz]=coarse;
  const foldX=new Float32Array(bx+1),foldY=new Float32Array(by+1);
  for(let i=0;i<=bx;i++){const x=axes[0][i*BRICK];foldX[i]=.25*Math.sin(x*.95)+.12*Math.cos(x*1.65);}
  for(let j=0;j<=by;j++){const y=axes[1][j*BRICK];foldY[j]=.21*Math.cos(y*1.3);}
  // RGBA32F axis table: R = X, G = Y, B = Z; fold texture R/G = fold X/Y.
  const axisData=new Float32Array((Math.max(...dims)+1)*4);
  axes.forEach((a,k)=>a.forEach((v,i)=>{axisData[i*4+k]=v;}));
  const foldData=new Float32Array((Math.max(bx,by)+1)*4);
  foldX.forEach((v,i)=>{foldData[i*4]=v;});foldY.forEach((v,i)=>{foldData[i*4+1]=v;});
  const count=nx*ny*nz,attributes=new Uint8Array(count*4),bricks=new Uint8Array(bx*by*bz*4),histogram=new Uint32Array(256);
  for(let i=0;i<bricks.length;i+=4)bricks[i]=255;
  const channels=new Float32Array(nx*ny),lateral=new Float32Array(nx*ny);
  for(let j=0;j<ny;j++)for(let i=0;i<nx;i++){
    const u=(i+.5)/nx*2-1,v=(j+.5)/ny*2-1,h=j*nx+i;
    channels[h]=Math.exp(-((v-.28*Math.sin(u*4.3)-.06)**2)/.07);
    lateral[h]=.08*Math.sin(u*3.1+v*2.3);
  }
  for(let k=0;k<nz;k++){
    const z=(k+.5)/nz,layerPhi=.10*Math.sin(z*14),layerK=.11*Math.sin(z*9.5);
    for(let j=0;j<ny;j++)for(let i=0;i<nx;i++){
      const column=j*nx+i,h=k*nx*ny+column,offset=h*4,c=channels[column];
      let hash=Math.imul(h+17,1597334677);hash=Math.imul(hash^(hash>>>16),2246822519);hash^=hash>>>13;
      const noise=((hash>>>0)/4294967295-.5)*.10;
      const oil=Math.round(clamp(.14+.67*z+.10*c+lateral[column]+noise-(i>=split?.035:0))*255);
      const phi=Math.round(clamp(.24+.45*c+layerPhi+lateral[column]*.4+noise)*255);
      const perm=Math.round(clamp(.12+.68*c+layerK+noise*1.3)*255);
      attributes[offset]=oil;attributes[offset+1]=phi;attributes[offset+2]=perm;attributes[offset+3]=255;histogram[phi]++;
      const bi=((Math.floor(k/BRICK)*by+Math.floor(j/BRICK))*bx+Math.floor(i/BRICK))*4;
      bricks[bi]=Math.min(bricks[bi],phi);bricks[bi+1]=Math.max(bricks[bi+1],phi);bricks[bi+3]=255;
    }
    progress((k+1)/nz);
  }
  const bounds={min:[-3.5,-2.1,-1.7],max:[3.5,2.2,1.5]};
  const gpuBytes=attributes.byteLength+bricks.byteLength+axisData.byteLength+foldData.byteLength;
  return {kind:'large',scale,dims,coarse,axes,foldX,foldY,axisData,foldData,attributes,bricks,histogram,bounds,
    stats:{cells:count,bricks:bx*by*bz,gpuBytes,propertyBytes:attributes.byteLength},synthetic:true};
}
export function largePorosityRange(minimum,maximum){
  // Inclusive percent range, using the actual quantized attribute values.
  const lo=Math.max(0,Math.ceil((minimum-8)/24*255-1e-9));
  const hi=Math.min(255,Math.floor((maximum-8)/24*255+1e-9));
  return [lo,hi];
}
export function countLargeMatches(volume,settings){
  if(!settings.porosityFilter)return volume.stats.cells;
  const [lo,hi]=largePorosityRange(settings.porosityMin,settings.porosityMax);
  let n=0;for(let i=lo;i<=hi;i++)n+=volume.histogram[i];return n;
}
