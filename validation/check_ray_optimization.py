"""Same-resolution GLES differential and work counters; no hardware FPS claims.
Usage: python ... FIXTURE OUTPUT.npz [color|work]
Set EXPLICIT_FRAGMENT to the production shader or its instrumented counterpart.
"""
from check_explicit_gl import *
if os.environ.get("BLOCK_INDEX"):
    from block_gl import *
mode=sys.argv[3] if len(sys.argv)>3 else 'color'
cases=[{},dict(density=100),dict(edges=False),dict(density=15),dict(density=0),dict(density=0,edges=False),dict(axis=1,clip=38),dict(axis=2,clip=38),dict(axis=3,clip=38),dict(filter_enabled=True,phi_min=18,phi_max=25),dict(filter_enabled=True,phi_min=24,axis=1,clip=38),dict(prop=1),dict(prop=2),dict(interior=False),dict(no_matches=True)]
images=[]
for az,el in [(-.87,.52),(2.3,.4),(-.8,-.6)]:
 camera(az,el)
 for light in [0,1]:
  ui(loc('uLightMode'),light)
  for args in cases:
   image,_=render(**args);images.append(image)
if os.environ.get('BLOCK_STRESS'):
 for az,el,distance in [(0,0,10.2),(np.pi/2,0,10.2),(np.pi,0,10.2),(-np.pi/2,0,10.2),(0,np.pi/2,10.2),(0,-np.pi/2,10.2),(-.87,.52,.7)]:
  camera(az,el,distance)
  for args in cases:
   image,_=render(**args);images.append(image)
np.savez_compressed(sys.argv[2],images=np.array(images))
if mode=='work':
 pixels=np.array(images);assert pixels[:,:,:,:2].max()<255,'Counter overflow'
 print('Executed shader counters: corners',int(pixels[:,:,:,0].sum()),'cell intervals',int(pixels[:,:,:,1].sum()),'opaque stopped rays',int((pixels[:,:,:,2]>0).sum()),flush=True)
else:print('Captured',len(images),'full-resolution images',flush=True)
