from check_explicit_gl import *
cases=[(8,32),(18,25),(24,32),(18,18.1),(18.1,18.101),(24,24.1),(32,32)]
results={}
for low,high in cases:
    pixels,secs=render(filter_enabled=True,phi_min=low,phi_max=high,density=15)
    results[f'{low}-{high}']=pixels
    print('filter profile',low,high,secs,flush=True)
if len(sys.argv)>2:np.savez(sys.argv[2],**results)
