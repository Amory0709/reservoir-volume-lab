"""Near-edge rays must not invent an entry at the camera, ahead of cell bounds."""
import os
os.environ.setdefault('EXPLICIT_FRAGMENT','boundary.glsl')
from check_explicit_gl import *
vertices=np.memmap(root/'vertices.bin',np.float32,mode='r').reshape(-1,4)
nx,ny,nz=meta['dims'];vx,vy,vz=meta['nodeDims']
corners=np.array([[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]])
edges=np.array([[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]])
t=U();gen(1,c.byref(t));active(0x84c4);bind(0xde1,t)
for a,b in [(0x2801,0x2600),(0x2800,0x2600),(0x2802,0x812f),(0x2803,0x812f)]:param(0xde1,a,b)
ui(loc('uTestRays'),4);rng=np.random.default_rng(14500);bad=0;hits=0;total=0
for i,j,k in [(nx//2+1,ny//4,nz//2),(nx//4-1,ny//2-1,nz-1),(nx-2,ny-2,2)]:
    ii=i+sum(i>=s for s in meta['splitsX']);jj=j+(j>=meta['splitY'])
    points=vertices[((k+corners[:,2])*vy+jj+corners[:,1])*vx+ii+corners[:,0],:3].astype(float)
    center=points.mean(axis=0);size=np.min(np.linalg.norm(points[edges[:,1]]-points[edges[:,0]],axis=1))
    for az,el in [(-.87,.52),(2.3,.4),(-1.57,1.57),(-.8,-.6)]:
        ro=center+10*np.array([np.cos(el)*np.cos(az),np.cos(el)*np.sin(az),np.sin(el)]);ro=ro.astype(np.float32)
        u3(loc('uEye'),*ro);u3i(loc('uTestCell'),i,j,k)
        e=edges[np.arange(w*h)%12];mix=rng.random(w*h)
        mix[:w*h//4]=0
        target=points[e[:,0]]*(1-mix[:,None])+points[e[:,1]]*mix[:,None]
        jitter=rng.normal(size=(w*h,3))*size*10**rng.uniform(-7,-3,(w*h,1))
        directions=target+jitter-ro;directions/=np.linalg.norm(directions,axis=1)[:,None]
        data=np.ones((w*h,4),np.float32);data[:,:3]=directions
        tex2(0xde1,0,0x8814,w,h,0,0x1908,0x1406,data.ctypes.data)
        draw(4,0,3);finish();pixels=np.zeros((h,w,4),np.uint8);read(0,0,w,h,0x1908,0x1401,pixels.ctypes.data)
        assert error()==0
        bad+=int((pixels[:,:,0]>200).sum());hits+=int((pixels[:,:,1]>200).sum());total+=w*h
print('Boundary rays',{'rays':total,'valid_intervals':hits,'false_camera_entries':bad},flush=True)
if not os.environ.get('ALLOW_OLD_ERRORS'):assert bad==0,'False cell entry creates bright color specks'
