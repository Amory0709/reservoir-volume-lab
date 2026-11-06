"""Warm, completed GLES timings at identical pixels; software-driver results
are not browser or discrete-GPU benchmarks. Run variants sequentially.
Usage: EXPLICIT_FRAGMENT=shader python validation/profile_explicit.py FIXTURE OUT
"""
from check_explicit_gl import *
if os.environ.get("BLOCK_INDEX"):
    from block_gl import *
cases=[('opaque',{}),('transparent',dict(density=15)),('filtered',dict(filter_enabled=True,phi_min=24)),('section',dict(axis=1,clip=38))]
if os.environ.get('PROFILE_CASE'):cases=[case for case in cases if case[0]==os.environ['PROFILE_CASE']]
records=[];images=[]
for name,args in cases:
    render(**args)
    samples=[]
    for _ in range(int(os.environ.get('PROFILE_RUNS',3))):
        image,seconds=render(**args);samples.append(seconds)
    images.append(image)
    record=dict(case=name,seconds=samples,median=float(np.median(samples)))
    records.append(record);print(record,flush=True)
np.savez_compressed(sys.argv[2]+'.npz',images=np.array(images))
Path(sys.argv[2]+'.json').write_text(json.dumps(dict(cells=meta['stats']['cells'],width=w,height=h,driver=get_string(0x1f01).decode(),results=records)))
