"""Independent reference: intersect every affine macro brick, then all of its
1,000 cells by vectorized slab tests. No neighbor walk or DDA traversal."""
import json
from pathlib import Path
import numpy as np
import sys
root=Path(sys.argv[1])
meta=json.loads((root/'metadata.json').read_text())
nx,ny,nz=meta['dims'];bx,by,bz=meta['coarse']
axis=np.fromfile(root/'axisData.bin',np.float32).reshape(-1,4).astype(float)
fold=np.fromfile(root/'foldData.bin',np.float32).reshape(-1,4).astype(float)
props=np.memmap(root/'attributes.bin',np.uint8,mode='r',shape=(nz,ny,nx,4))
k,j,i=np.meshgrid(np.arange(bz),np.arange(by),np.arange(bx),indexing='ij')
macro=np.stack([i.ravel(),j.ravel(),k.ravel()],axis=1)
lo=np.stack([axis[macro[:,d]*10,d] for d in range(3)],axis=1)
hi=np.stack([axis[(macro[:,d]+1)*10,d] for d in range(3)],axis=1)
slopes=np.stack([(fold[macro[:,0]+1,0]-fold[macro[:,0],0])/(hi[:,0]-lo[:,0]),(fold[macro[:,1]+1,1]-fold[macro[:,1],1])/(hi[:,1]-lo[:,1])],axis=1)
right=macro[:,0]>=bx//2
intercept=fold[macro[:,0],0]+fold[macro[:,1],1]-(slopes*lo[:,:2]).sum(axis=1)-right*.37
zz,yy,xx=np.meshgrid(np.arange(10),np.arange(10),np.arange(10),indexing='ij')
local=np.stack([xx.ravel(),yy.ravel(),zz.ravel()],axis=1)
def reference_alpha(eye,direction,density=15,phi_min=8,phi_max=32,clip_axis=0,clip=0):
    br=np.array([eye[0]-.11*eye[2],eye[1]-.055*eye[2],eye[2]])
    bd=np.array([direction[0]-.11*direction[2],direction[1]-.055*direction[2],direction[2]])
    ro=np.broadcast_to(br,(len(macro),3)).copy();ro[:,0]-=np.where(right,.075,-.075)
    ro[:,2]-=intercept+(slopes*ro[:,:2]).sum(axis=1)
    rd=np.broadcast_to(bd,(len(macro),3)).copy();rd[:,2]-=(slopes*bd[:2]).sum(axis=1)
    inv=1/np.where(abs(rd)>1e-14,rd,1e-14)
    t0=(lo-ro)*inv;t1=(hi-ro)*inv
    near=np.maximum(np.minimum(t0,t1).max(axis=1),0);far=np.maximum(t0,t1).min(axis=1)
    if clip_axis:
        d=clip_axis-1;position=meta['bounds']['max'][d]-(meta['bounds']['max'][d]-meta['bounds']['min'][d])*clip/100
        if abs(direction[d])<1e-14:
            if eye[d]>position:return 0
        elif direction[d]>0:far=np.minimum(far,(position-eye[d])/direction[d])
        else:near=np.maximum(near,(position-eye[d])/direction[d])
    optical=0.
    qlo=int(np.ceil((phi_min-8)/24*255-1e-9));qhi=int(np.floor((phi_max-8)/24*255+1e-9))
    for m in np.flatnonzero(far>near+1e-8):
        cells=macro[m]*10+local
        clo=np.stack([axis[cells[:,d],d] for d in range(3)],axis=1)
        chi=np.stack([axis[cells[:,d]+1,d] for d in range(3)],axis=1)
        a=(clo-ro[m])*inv[m];b=(chi-ro[m])*inv[m]
        n=np.maximum(np.minimum(a,b).max(axis=1),near[m]);f=np.minimum(np.maximum(a,b).min(axis=1),far[m])
        values=props[cells[:,2],cells[:,1],cells[:,0]]
        keep=(values[:,1]>=qlo)&(values[:,1]<=qhi)
        optical+=np.sum(np.maximum(0,f-n)*keep*(.8+.4*values[:,0]/255))
    return 1-np.exp(-28*(density/100)**2*optical)
