/** Percent-valued UI bounds mapped to the same float32 values used by GLSL. */
export function porosityBounds(minimum,maximum) {
  if(!Number.isFinite(minimum)||!Number.isFinite(maximum)||minimum<8||maximum>32||minimum>maximum) throw new Error('孔隙度范围必须满足 8% ≤ 下限 ≤ 上限 ≤ 32%。');
  return [Math.fround((minimum-8)/24),Math.fround((maximum-8)/24)];
}

export function countPorosityMatches(properties,settings) {
  if(!settings.porosityFilter)return properties.length;
  const [lo,hi]=porosityBounds(settings.porosityMin,settings.porosityMax);
  let count=0;
  for(const p of properties){const phi=Math.fround(p[1]);if(phi>=lo&&phi<=hi)count++;}
  return count;
}
