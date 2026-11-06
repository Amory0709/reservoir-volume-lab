"""Generate GLES images using the existing production GLSL as a differential oracle."""
from check_explicit_gl import *
out=Path(sys.argv[2]);cases=json.loads((out/'cases.json').read_text())
for case in cases:
    ui(loc('uLightMode'),int(case['lightMode']))
    pixels,_=render(**case['args'])
    np.save(out/('reference-'+str(case['index'])+'.npy'),np.flipud(pixels).astype(np.uint8))
print('Saved',len(cases),'GLES reference images',flush=True)
if (out/'surface-cases.json').exists():
 for case in json.loads((out/'surface-cases.json').read_text()):
    s=case['settings'];camera(case['az'],case['el']);ui(loc('uLightMode'),int(s['lightMode']))
    pixels,_=render(surface=True,density=s['density'],edges=s['edges'],axis=s['clipAxis'],clip=s['clip'],prop=s['property'],filter_enabled=s['porosityFilter'],phi_min=s['porosityMin'],phi_max=s['porosityMax'])
    np.save(out/('surface-reference-'+str(case['index'])+'.npy'),np.flipud(pixels).astype(np.uint8))
 print('Saved surface GLES references',flush=True)
