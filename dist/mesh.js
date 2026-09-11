/** Framework-independent geometry preparation. Coordinates use Z as up. */
export const sub = (a, b) => a.map((x, i) => x - b[i]);
export const add = (a, b) => a.map((x, i) => x + b[i]);
export const scale = (a, s) => a.map(x => x * s);
export const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
export const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
export const normalize = a => scale(a, 1 / Math.max(1e-20, Math.hypot(...a)));
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
export const HEX_TETS = [[0,1,2,6],[0,2,3,6],[0,3,7,6],[0,7,4,6],[0,4,5,6],[0,5,1,6]];
export const HEX_FACES = [[0,1,2,3],[4,5,6,7],[0,1,5,4],[3,2,6,7],[0,3,7,4],[1,2,6,5]];
export const HEX_EDGES = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
export const TEXTURE_WIDTH = 1024;

/** Synthetic corner-defined grid, two disconnected fault blocks; no field data. */
export function createSyntheticGrid() {
  const nx=24, ny=14, nz=9, split=12;
  const vertices=[], cells=[], properties=[], indices=[], vertexMap=new Map();
  function vertex(i,j,k,block) {
    const key=`${block}/${i}/${j}/${k}`;
    if(vertexMap.has(key)) return vertexMap.get(key);
    const u=i/nx, v=j/ny, t=k/nz;
    const x0=(u-.5)*6.2 + .085*Math.sin(i*.91) + .07*Math.sin(j*.81+i*.73);
    const y0=(v-.5)*3.7 + .065*Math.sin(j*.88) + .06*Math.sin(i*.86+j*.63);
    const x=x0 + .09*(t-.5)*Math.cos(y0*.8) + (block ? .065 : -.065);
    const y=y0 + .1*(t-.5)*Math.sin(x0*.7);
    const fold=.19*Math.sin(x0*.95+.5) + .19*Math.cos(y0*1.2) + .26*Math.exp(-.5*x0*x0-.35*y0*y0);
    const thickness=1.36+.19*Math.sin(x0*.8-y0*.45);
    const z=fold + (t-.5)*thickness + .025*Math.sin(i*1.3+j*.8)*Math.sin(t*Math.PI) - (block ? .37 : 0);
    const id=vertices.length; vertices.push([x,y,z]); vertexMap.set(key,id); return id;
  }
  for(let k=0;k<nz;k++) for(let j=0;j<ny;j++) for(let i=0;i<nx;i++) {
    const u=(i+.5)/nx*2-1, v=(j+.5)/ny*2-1;
    // An irregular footprint with inactive columns, retaining conforming faces.
    if(Math.pow(Math.abs(u),4)+Math.pow(Math.abs(v),4)>1.14 || (i>20 && j<2) || (i<2 && j>10)) continue;
    const block=i>=split?1:0;
    cells.push([[i,j,k],[i+1,j,k],[i+1,j+1,k],[i,j+1,k],[i,j,k+1],[i+1,j,k+1],[i+1,j+1,k+1],[i,j+1,k+1]].map(p=>vertex(...p,block)));
    const l=(k+.5)/nz;
    const channel=Math.exp(-Math.pow(v-.27*Math.sin(u*4.3)-.08,2)/.09);
    const grain=.055*Math.sin(i*7.13+j*3.77+k*5.41);
    const oil=clamp(.14+.68*l+.11*Math.sin(u*2.8+v*2.1)+.1*channel+grain-(block?.05:0));
    const porosity=clamp(.23+.44*channel+.13*Math.sin(l*13+u*3)+grain);
    const permeability=clamp(.12+.68*channel+.13*Math.sin(l*9.5+v*3)+grain*1.5);
    properties.push([oil,porosity,permeability,block]);
    indices.push([i,j,k]);
  }
  return {vertices,cells,properties,indices,dimensions:[nx,ny,nz]};
}

function pack(values) {
  const height=Math.max(1, Math.ceil(values.length/(TEXTURE_WIDTH*4)));
  const data=new Float32Array(TEXTURE_WIDTH*height*4); data.set(values);
  return {data,width:TEXTURE_WIDTH,height};
}

/**
 * Connectivity is vertex IDs, never inferred by rounding coordinates. Each hex
 * has conventional corner order 000,100,110,010,001,101,111,011. The shared
 * 0–6 tetrahedralization agrees across shared faces. Actual hex edges alone
 * are retained for display; tetrahedral diagonals are never used as grid lines.
 */
export function buildVolumeData(grid) {
  const {vertices,cells,properties}=grid;
  const tets=[], faceMap=new Map(), boundary=[];
  let minVolume=Infinity;
  for(let h=0;h<cells.length;h++) {
    if(cells[h].length!==8) throw new Error('每个六面体必须有 8 个角点。');
    for(const pattern of HEX_TETS) {
      const ids=pattern.map(i=>cells[h][i]), p=ids.map(id=>vertices[id]);
      if(p.some(v=>!v || v.length!==3 || v.some(x=>!Number.isFinite(x)))) throw new Error('网格含无效顶点。');
      const volume=dot(sub(p[1],p[0]),cross(sub(p[2],p[0]),sub(p[3],p[0])))/6;
      if(volume<1e-9) throw new Error('网格含反转或退化的四面体。');
      minVolume=Math.min(minVolume,volume);
      const id=tets.length, planes=[], faces=[];
      for(let f=0;f<4;f++) {
        let vi=[0,1,2,3].filter(i=>i!==f);
        let [a,b,c]=vi.map(i=>p[i]);
        let n=normalize(cross(sub(b,a),sub(c,a)));
        if(dot(n,sub(p[f],a))>0) {vi=[vi[0],vi[2],vi[1]]; n=scale(n,-1);}
        planes.push([...n,-dot(n,a)]);
        const fi=vi.map(i=>ids[i]); faces.push(fi);
        const key=[...fi].sort((a,b)=>a-b).join(',');
        if(faceMap.has(key)) {
          const other=faceMap.get(key);
          if(other.paired) throw new Error('存在非流形网格面。');
          other.paired=true;
          tets[other.tet].neighbors[other.face]=id;
          // Store pending twin because the current tet is not yet appended.
          faces[f].twin=other.tet;
        } else faceMap.set(key,{tet:id,face:f,paired:false});
      }
      tets.push({hex:h,ids,planes,faces,neighbors:faces.map(f=>f.twin??-1)});
    }
  }
  for(const face of faceMap.values()) if(!face.paired) {
    const tet=tets[face.tet];
    const p=tet.faces[face.face].map(id=>vertices[id]);
    const lo=[0,1,2].map(d=>Math.min(...p.map(v=>v[d]))-1e-5);
    const hi=[0,1,2].map(d=>Math.max(...p.map(v=>v[d]))+1e-5);
    boundary.push({p,tet:face.tet,lo,hi,center:lo.map((v,d)=>(v+hi[d])/2)});
  }
  // Stackless BVH: each node records its escape index, eliminating a GLSL stack.
  const nodes=[], triangles=[];
  function build(items,depth=0) {
    const lo=[0,1,2].map(d=>Math.min(...items.map(t=>t.lo[d])));
    const hi=[0,1,2].map(d=>Math.max(...items.map(t=>t.hi[d])));
    const node={lo,hi,escape:0,start:0,count:0,depth}; nodes.push(node);
    if(items.length<=6) {node.start=triangles.length;node.count=items.length;triangles.push(...items);}
    else {
      const extent=sub(hi,lo), axis=extent.indexOf(Math.max(...extent));
      items.sort((a,b)=>a.center[axis]-b.center[axis]);
      const mid=Math.floor(items.length/2); build(items.slice(0,mid),depth+1);build(items.slice(mid),depth+1);
    }
    node.escape=nodes.length;
  }
  build(boundary.slice());
  if(nodes.length>2048) throw new Error('该网格超出当前演示的 BVH 规模上限。请先分块或提高着色器的遍历上限。');
  const tetraValues=[];
  for(const tet of tets) {tet.planes.forEach(p=>tetraValues.push(...p));tetraValues.push(...tet.neighbors);}
  const cellValues=[];
  for(let h=0;h<cells.length;h++) {
    for(const id of cells[h]) cellValues.push(...vertices[id],0);
    cellValues.push(...properties[h]);
  }
  const nodeValues=[];
  for(const n of nodes) nodeValues.push(...n.lo,n.escape,...n.hi,n.count,n.start,0,0,0);
  const triangleValues=[];
  for(const tri of triangles) triangleValues.push(...tri.p[0],tri.tet,...sub(tri.p[1],tri.p[0]),0,...sub(tri.p[2],tri.p[0]),0);
  const bounds={min:nodes[0].lo,max:nodes[0].hi};
  return {
    tetraTexture:pack(tetraValues),cellTexture:pack(cellValues),nodeTexture:pack(nodeValues),triangleTexture:pack(triangleValues),
    bounds,grid,tets,nodes,triangles,
    stats:{cells:cells.length,tetrahedra:tets.length,boundaryTriangles:boundary.length,bvhNodes:nodes.length,bvhDepth:Math.max(...nodes.map(n=>n.depth)),minTetraVolume:minVolume}
  };
}
