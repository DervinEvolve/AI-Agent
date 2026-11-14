import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_FILE_BYTES, MAX_TRIANGLES, SLUG_RE, estimateTriangles, validateExhibit } from '../scripts/exhibits'

const root = join(__dirname, '..', 'exhibits')
const slugs = existsSync(root) ? readdirSync(root).filter((n) => statSync(join(root, n)).isDirectory()) : []

const base = () => ({
  version: 1,
  title: 'Test',
  description: 'A test exhibit.',
  author_model: 'Observable Lab',
  placement: 'shelf',
  palette: ['#B5A642'],
  parts: [{ shape: 'box', size: [0.1, 0.1, 0.1], position: [0, 0, 0], colour: 0, material: 'brass' }],
})

describe('exhibits in the repository', () => {
  it('has at least one exhibit', () => expect(slugs.length).toBeGreaterThan(0))

  for (const slug of slugs) {
    describe(slug, () => {
      it('has a valid slug and holds only exhibit.json', () => {
        expect(slug).toMatch(SLUG_RE)
        expect(readdirSync(join(root, slug))).toEqual(['exhibit.json'])
      })
      it('is valid version 1 data within the triangle budget', () => {
        const file = join(root, slug, 'exhibit.json')
        expect(statSync(file).size).toBeLessThanOrEqual(MAX_FILE_BYTES)
        const data = JSON.parse(readFileSync(file, 'utf8'))
        expect(validateExhibit(data)).toEqual([])
        expect(estimateTriangles(data)).toBeLessThanOrEqual(MAX_TRIANGLES)
      })
    })
  }
})

describe('exhibit validator', () => {
  it('accepts a minimal exhibit', () => expect(validateExhibit(base())).toEqual([]))
  it('rejects unknown keys, bad palette index and URLs', () => {
    const d: any = base()
    d.script = 'x'
    d.parts[0].colour = 3
    d.description = 'see https://example.com'
    const errs = validateExhibit(d).join('\n')
    expect(errs).toMatch(/unknown key "script"/)
    expect(errs).toMatch(/colour/)
    expect(errs).toMatch(/URLs/)
  })
  it('rejects out of range sizes and positions', () => {
    const d: any = base()
    d.parts[0].size = [3, 0.1, 0.1]
    d.parts[0].position = [0, 2, 0]
    expect(validateExhibit(d).length).toBe(2)
  })
  it('requires a path for a tube only', () => {
    const d: any = base()
    d.parts[0].shape = 'tube'
    expect(validateExhibit(d).join()).toMatch(/path/)
    d.parts[0].path = [[0, 0, 0], [0, 0.5, 0]]
    expect(validateExhibit(d)).toEqual([])
    d.parts[0].shape = 'box'
    expect(validateExhibit(d).join()).toMatch(/only a tube/)
  })
  it('rejects more than 6,000 triangles', () => {
    const d: any = base()
    d.parts = Array.from({ length: 12 }, () => ({ shape: 'torus', size: [0.2, 0.2, 0.2], position: [0, 0, 0], colour: 0, material: 'brass', repeat: { count: 2 } }))
    expect(estimateTriangles(d)).toBe(13824)
    expect(validateExhibit(d).join()).toMatch(/triangles/)
  })
  it('rejects too many parts, bad animation and bad version', () => {
    const d: any = base()
    d.version = 2
    d.animation = { spin: 5 }
    d.parts = Array.from({ length: 65 }, () => base().parts[0])
    const errs = validateExhibit(d).join('\n')
    expect(errs).toMatch(/version/)
    expect(errs).toMatch(/animation.spin/)
    expect(errs).toMatch(/parts: 1 to 64/)
  })
})
