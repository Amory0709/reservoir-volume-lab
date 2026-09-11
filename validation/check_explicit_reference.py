"""Independent oracle: intersect all six tetrahedra of EVERY cell in float64.
No BVH, neighbor walk or triangle ray tests are used by the CPU reference.
"""
import os
os.environ['EXPLICIT_ALPHA']='1'
from check_explicit_gl import *
assert meta['stats']['cells']<100000,'Brute-force oracle is for the small topology fixture'
dims=np.array(meta['dims']);nx,ny,nz=dims;vx,vy,vz=meta['nodeDims']
verts=np.fromfile(root/'vertices.bin',np.float32).reshape(-1,4)[:,:3].astype(float)
props=np.fromfile(root/'attributes.bin',np.float32).reshape(-1,4)
kk,jj,ii=np.indices((nz,ny,nx));ii=ii.ravel();jj=jj.ravel();kk=kk.ravel()
offsets=np.array([[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]])
if imported:
    columns=np.fromfile(root/'columnPillars.bin',np.uint32).reshape(-1,4)
    layers=np.fromfile(root/'kInterfaces.bin',np.uint32).reshape(-1,2)
    ids=np.array([layers[kk,c//4]*vx*vy+columns[jj*nx+ii,c%4] for c in range(8)]).T
else:
    xi=ii+sum(ii>=s for s in meta['splitsX']);yj=jj+(jj>=meta['splitY'])
    ids=np.array([((kk+dz)*vy+yj+dy)*vx+xi+dx for dx,dy,dz in offsets]).T
cells=verts[ids];tets=np.array([[0,1,2,6],[0,2,3,6],[0,3,7,6],[0,7,4,6],[0,4,5,6],[0,5,1,6]])
points=cells[:,tets].reshape(-1,4,3);origins=points[:,0];matrix=(points[:,1:]-origins[:,None]).transpose(0,2,1)
assert np.all(abs(np.linalg.det(matrix))>1e-15),'Degenerate tetrahedron'
inverse=np.linalg.inv(matrix)
def integral(ro,rd,lower,upper,lo,hi):
    start=np.einsum('nij,nj->ni',inverse,ro-origins);direction=np.einsum('nij,j->ni',inverse,rd)
    start=np.column_stack((start,1-start.sum(axis=1)));direction=np.column_stack((direction,-direction.sum(axis=1)))
    with np.errstate(divide='ignore',invalid='ignore'):crossings=-start/direction
    tmin=np.maximum(lower,np.max(np.where(direction>1e-13,crossings,-np.inf),axis=1))
    tmax=np.minimum(upper,np.min(np.where(direction< -1e-13,crossings,np.inf),axis=1))
    parallel_bad=np.any((abs(direction)<=1e-13)&(start<0),axis=1)
    mask=(props[:,3]>0)&(props[:,1]>=np.float32(lo/100))&(props[:,1]<=np.float32(hi/100))
    length=np.maximum(0,tmax-tmin);length[parallel_bad|~np.repeat(mask,6)]=0
    return length.sum()
maximum=0;tested=0
for az,el in [(-.87,.52),(2.3,.4),(-1.57,1.57),(-.8,-.6)]:
    ro,forward,right,up=camera(az,el)
    for axis,clip,lo,hi in [(0,0,8,32),(1,38,8,32),(2,38,18,25),(3,38,24,32)]:
        actual,_=render(density=15,edges=False,axis=axis,clip=clip,filter_enabled=True,phi_min=lo,phi_max=hi)
        errors=[]
        for y in range(5,h,8):
            for x in range(5,w,10):
                xy=(np.array([x+.5,y+.5])*2-[w,h])/h
                rd=forward+np.tan(np.deg2rad(21))*(xy[0]*right+xy[1]*up);rd/=np.linalg.norm(rd)
                lower,upper=0.,1e25
                if axis:
                    a=axis-1;plane=meta['bounds']['max'][a]-(meta['bounds']['max'][a]-meta['bounds']['min'][a])*clip/100
                    t=(plane-ro[a])/rd[a]
                    if rd[a]<0:lower=max(0,t)
                    else:upper=t
                length=integral(ro,rd,lower,upper,lo,hi) if upper>lower else 0
                expected=(1-np.exp(-28*.15**2*length))*255;delta=abs(actual[y,x,0]-expected)
                errors.append(delta);tested+=1
        worst=max(errors);maximum=max(maximum,worst)
        assert worst<1.05,('Ray integral mismatch',az,el,axis,worst)
print('PASS independent all-tetrahedra oracle',{'rays':tested,'max_8bit_alpha_error':maximum},flush=True)
