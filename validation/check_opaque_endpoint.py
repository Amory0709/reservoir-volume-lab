"""Compare opaque density to an independently captured first-surface baseline.

Run with OPAQUE_REFERENCE=1 and the pre-change EXPLICIT_FRAGMENT to capture
the existing opaque preview. Run normally with the new shader, then compare.
"""
from check_explicit_gl import *

reference = os.environ.get('OPAQUE_REFERENCE') == '1'
images = []
cases = [{}, dict(edges=False), dict(interior=False),
         dict(axis=1, clip=38), dict(axis=2, clip=38), dict(axis=3, clip=38),
         dict(filter_enabled=True, phi_min=18, phi_max=25),
         dict(filter_enabled=True, phi_min=24, axis=1, clip=38),
         dict(prop=1), dict(prop=2), dict(no_matches=True)]
for az, el in [(-.87, .52), (2.3, .4), (-.8, -.6)]:
    camera(az, el)
    for light in [0, 1]:
        ui(loc('uLightMode'), light)
        for args in cases:
            pixels, _ = render(density=60 if reference else 100,
                               surface=reference, **args)
            images.append(pixels)
np.savez_compressed(sys.argv[2], images=np.array(images))
print('Captured', len(images), 'opaque reference' if reference else 'density=100',
      'frames', flush=True)
