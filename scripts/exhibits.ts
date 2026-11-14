// Exhibit checker (version 1). Plain TypeScript, no dependencies, so the
// test in tests/exhibits.test.ts can run it in CI. The numbers here must match
// exhibits/schema.json and the room's segment counts; docs live in
// exhibits/README.md.

export const SLUG_RE = /^[a-z0-9-]{3,40}$/
export const HEX_RE = /^#[0-9a-fA-F]{6}$/
export const MAX_TRIANGLES = 6000
export const MAX_PARTS = 64
export const MAX_FILE_BYTES = 32 * 1024

export const PLACEMENTS = ['pedestal', 'shelf', 'wall', 'ceiling', 'floor'] as const
export const SHAPES = ['box', 'sphere', 'cylinder', 'cone', 'torus', 'capsule', 'ring', 'tube'] as const
export const MATERIALS = ['wood', 'brass', 'glass', 'paper', 'stone', 'ceramic', 'leaf', 'light'] as const

// Triangles per shape at the room's fixed segment counts. Cone and capsule are
// counted a little high on purpose, so the estimate is never lower than the room.
const FIXED_TRIANGLES: Record<string, number> = {
  box: 12,
  sphere: 16 * 12 * 2 - 2 * 16, // 16 x 12 -> 352
  cylinder: 16 * 2 + 16 * 2, // 16 radial, side + two caps -> 64
  cone: 16 * 2 + 16, // 16 radial, side + one cap -> 48
  torus: 12 * 24 * 2, // 12 x 24 -> 576
  capsule: (2 * 8 + 1) * 16 * 2, // 8 cap segments, 16 radial -> 544
  ring: 24 * 2, // 24 segments -> 48
}
const TUBE_RADIAL = 8

export function partTriangles(part: { shape: string; path?: unknown[]; repeat?: { count?: number } }): number {
  let each: number
  if (part.shape === 'tube') {
    const points = Array.isArray(part.path) ? part.path.length : 0
    each = TUBE_RADIAL * 2 * Math.max(points - 1, 0)
  } else {
    each = FIXED_TRIANGLES[part.shape] ?? 0
  }
  const count = typeof part.repeat?.count === 'number' ? part.repeat.count : 1
  return each * count
}

export function estimateTriangles(data: { parts?: any[] }): number {
  return (data.parts ?? []).reduce((sum, p) => sum + (isObj(p) ? partTriangles(p as any) : 0), 0)
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function onlyKeys(o: Record<string, unknown>, allowed: string[], at: string, errs: string[]) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) errs.push(`${at}: unknown key "${k}"`)
}

function vec3(v: unknown, lo: number, hi: number, at: string, errs: string[]) {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(isNum)) {
    errs.push(`${at}: must be [x, y, z] numbers`)
    return
  }
  if (v.some((n) => n < lo || n > hi)) errs.push(`${at}: each value must be between ${lo} and ${hi}`)
}

// A data-only file: no URLs, no markup, no script-like strings anywhere, and
// no control characters. Same patterns as the lab server's check.
const UNSAFE_TEXT = /:\/\/|<\s*\/?\s*[a-z!?]|javascript:|data:|vbscript:|\bon[a-z]+\s*=|\bwww\./i
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/
function scanStrings(v: unknown, at: string, errs: string[]) {
  if (typeof v === 'string') {
    if (UNSAFE_TEXT.test(v)) errs.push(`${at}: strings may not hold URLs or markup`)
    if (CONTROL_CHARS.test(v)) errs.push(`${at}: strings may not hold control characters`)
  } else if (Array.isArray(v)) v.forEach((x, i) => scanStrings(x, `${at}[${i}]`, errs))
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) scanStrings(x, `${at}.${k}`, errs)
}

/** Returns a list of problems; empty means the exhibit is valid. */
export function validateExhibit(data: unknown): string[] {
  const errs: string[] = []
  if (!isObj(data)) return ['exhibit must be a JSON object']
  onlyKeys(data, ['version', 'title', 'description', 'author_model', 'placement', 'palette', 'parts', 'animation', 'label'], 'exhibit', errs)
  scanStrings(data, 'exhibit', errs)

  if (data.version !== 1) errs.push('version must be 1')
  const str = (k: string, max: number, min = 1) => {
    const v = data[k]
    if (typeof v !== 'string' || v.trim().length < min || v.length > max) errs.push(`${k}: must be a string of ${min}..${max} characters`)
  }
  str('title', 60)
  str('description', 400)
  str('author_model', 60)
  if (data.label !== undefined) str('label', 40)

  if (!PLACEMENTS.includes(data.placement as any)) errs.push(`placement must be one of ${PLACEMENTS.join(', ')}`)

  let paletteLen = 0
  if (!Array.isArray(data.palette) || data.palette.length < 1 || data.palette.length > 6) errs.push('palette: 1 to 6 hex colours')
  else {
    paletteLen = data.palette.length
    data.palette.forEach((c, i) => {
      if (typeof c !== 'string' || !HEX_RE.test(c)) errs.push(`palette[${i}]: must be a #rrggbb colour`)
    })
  }

  if (data.animation !== undefined) {
    const a = data.animation
    if (!isObj(a)) errs.push('animation: must be an object')
    else {
      onlyKeys(a, ['spin', 'bob', 'pulse'], 'animation', errs)
      for (const [k, max] of [['spin', 1], ['bob', 0.2], ['pulse', 2]] as const) {
        const v = a[k]
        if (v !== undefined && (!isNum(v) || v < 0 || v > max)) errs.push(`animation.${k}: number from 0 to ${max}`)
      }
    }
  }

  if (!Array.isArray(data.parts) || data.parts.length < 1 || data.parts.length > MAX_PARTS) {
    errs.push(`parts: 1 to ${MAX_PARTS} parts`)
    return errs
  }
  data.parts.forEach((p, i) => {
    const at = `parts[${i}]`
    if (!isObj(p)) return void errs.push(`${at}: must be an object`)
    onlyKeys(p, ['shape', 'size', 'position', 'rotation', 'colour', 'material', 'repeat', 'path'], at, errs)
    if (!SHAPES.includes(p.shape as any)) errs.push(`${at}.shape: must be one of ${SHAPES.join(', ')}`)
    vec3(p.size, 0.01, 2, `${at}.size`, errs)
    vec3(p.position, -1.5, 1.5, `${at}.position`, errs)
    if (p.rotation !== undefined) vec3(p.rotation, -7, 7, `${at}.rotation`, errs)
    if (!Number.isInteger(p.colour) || (p.colour as number) < 0 || (p.colour as number) >= paletteLen) errs.push(`${at}.colour: index into the palette`)
    if (!MATERIALS.includes(p.material as any)) errs.push(`${at}.material: must be one of ${MATERIALS.join(', ')}`)
    if (p.repeat !== undefined) {
      const r = p.repeat
      if (!isObj(r)) errs.push(`${at}.repeat: must be an object`)
      else {
        onlyKeys(r, ['count', 'radial', 'linear'], `${at}.repeat`, errs)
        if (!Number.isInteger(r.count) || (r.count as number) < 1 || (r.count as number) > 24) errs.push(`${at}.repeat.count: integer 1..24`)
        if (r.radial !== undefined) {
          const rad = r.radial
          if (!isObj(rad)) errs.push(`${at}.repeat.radial: must be an object`)
          else {
            onlyKeys(rad, ['radius'], `${at}.repeat.radial`, errs)
            if (!isNum(rad.radius) || rad.radius < 0 || rad.radius > 1.5) errs.push(`${at}.repeat.radial.radius: 0..1.5`)
          }
        }
        if (r.linear !== undefined) {
          const lin = r.linear
          if (!isObj(lin)) errs.push(`${at}.repeat.linear: must be an object`)
          else {
            onlyKeys(lin, ['step'], `${at}.repeat.linear`, errs)
            vec3(lin.step, -1.5, 1.5, `${at}.repeat.linear.step`, errs)
          }
        }
      }
    }
    if (p.shape === 'tube') {
      if (!Array.isArray(p.path) || p.path.length < 2 || p.path.length > 16) errs.push(`${at}.path: a tube needs 2 to 16 points`)
      else p.path.forEach((pt, j) => vec3(pt, -1.5, 1.5, `${at}.path[${j}]`, errs))
    } else if (p.path !== undefined) errs.push(`${at}.path: only a tube has a path`)
  })

  const tris = estimateTriangles(data as { parts: any[] })
  if (tris > MAX_TRIANGLES) errs.push(`estimated ${tris} triangles, the limit is ${MAX_TRIANGLES}`)
  return errs
}
