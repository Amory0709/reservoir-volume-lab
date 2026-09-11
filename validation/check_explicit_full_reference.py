"""Full-size precision check. CPU BVH culls candidates, then independent
float64 tetrahedral clipping integrates every candidate (no GPU neighbor walk).
The small reference separately tests ALL cells without this culling.
"""
import os
os.environ['EXPLICIT_ALPHA']='1'
from check_explicit_gl import *
nx,ny,nz=meta['dims'];vx,vy,vz=meta['nodeDims'];gx,gy,gz=np.array(meta['dims'])//2
verts=np.memmap(root/'vertices.bin',np.float32,mode='r').reshape(-1,4)
props=np.memmap(root/'attributes.bin',np.float32,mode='r').reshape(-1,4)
nodes=np.memmap(root/'nodes.bin',np.float32,mode='r').reshape(-1,8)
offsets=np.array([[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]])
tets=np.array([[0,1,2,6],[0,2,3,6],[0,3,7,6],[0,7,4,6],[0,4,5,6],[0,5,1,6]])
def integral(ro,rd,lower,upper,lo,hi):
    inv=1/rd;stack=[0];candidates=[]
    while stack:
        id=stack.pop();node=nodes[id];a=(node[:3]-ro)*inv;b=(node[4:7]-ro)*inv
        if max(lower,np.minimum(a,b).max())>min(upper,np.maximum(a,b).min()):continue
        leaf=int(node[7])-1
        if leaf<0:stack.extend([id+1,int(nodes[id+1,3])]);continue
        x=(leaf%gx)*2;y=((leaf//gx)%gy)*2;z=(leaf//(gx*gy))*2
        candidates.extend([(x+dx,y+dy,z+dz) for dz in range(2) for dy in range(2) for dx in range(2)])
    if not candidates:return 0.
    ijk=np.array(candidates);ii,jj,kk=ijk.T;cellprops=props[(kk*ny+jj)*nx+ii]
    keep=(cellprops[:,3]>0)&(cellprops[:,1]>=np.float32(lo/100))&(cellprops[:,1]<=np.float32(hi/100))
    if not keep.any():return 0.
    ii=ii[keep];jj=jj[keep];kk=kk[keep];xi=ii+sum(ii>=s for s in meta['splitsX']);yj=jj+(jj>=meta['splitY'])
    ids=np.array([((kk+dz)*vy+yj+dy)*vx+xi+dx for dx,dy,dz in offsets]).T
    cells=verts[ids,:3].astype(float);points=cells[:,tets].reshape(-1,4,3);origins=points[:,0]
    matrix=(points[:,1:]-origins[:,None]).transpose(0,2,1);inverse=np.linalg.inv(matrix)
    start=np.einsum('nij,nj->ni',inverse,ro-origins);direction=np.einsum('nij,j->ni',inverse,rd)
    start=np.column_stack((start,1-start.sum(axis=1)));direction=np.column_stack((direction,-direction.sum(axis=1)))
    with np.errstate(divide='ignore',invalid='ignore'):crossings=-start/direction
    tmin=np.maximum(lower,np.max(np.where(direction>1e-13,crossings,-np.inf),axis=1))
    tmax=np.minimum(upper,np.min(np.where(direction< -1e-13,crossings,np.inf),axis=1))
    length=np.maximum(0,tmax-tmin);length[np.any((abs(direction)<=1e-13)&(start<0),axis=1)]=0
    return length.sum()
maximum=0;tested=0
for az,el in [(-.87,.52),(2.3,.4),(-1.57,1.57),(-.8,-.6)]:
    ro,forward,right,up=camera(az,el)
    for axis,clip,lo,hi in [(0,0,8,32),(1,38,8,32),(2,38,18,25),(3,38,24,32)]:
        actual,_=render(density=15,edges=False,axis=axis,clip=clip,filter_enabled=True,phi_min=lo,phi_max=hi)
        worst=0
        for y in range(16,h-8,16):
            for x in range(24,w-16,16):
                xy=(np.array([x+.5,y+.5])*2-[w,h])/h
                rd=forward+np.tan(np.deg2rad(21))*(xy[0]*right+xy[1]*up);rd/=np.linalg.norm(rd);lower,upper=0.,1e25
                if axis:
                    a=axis-1;plane=meta['bounds']['max'][a]-(meta['bounds']['max'][a]-meta['bounds']['min'][a])*clip/100;t=(plane-ro[a])/rd[a]
                    if rd[a]<0:lower=max(0,t)
                    else:upper=t
                length=integral(ro,rd,lower,upper,lo,hi) if upper>lower else 0
                delta=abs(actual[y,x,0]-(1-np.exp(-28*.15**2*length))*255);worst=max(worst,delta);tested+=1
        maximum=max(maximum,worst);print('reference',az,el,axis,'max error',worst,flush=True)
        assert worst<1.1,('Full-size precision mismatch',az,el,axis,worst)
print('PASS full-size float64 tetrahedra oracle',{'cells':meta['stats']['cells'],'rays':tested,'max_8bit_alpha_error':maximum},flush=True)
