import { describe, it, expect } from 'vitest'

describe('skeleton smoke', () => {
  it('package builds and imports', async () => {
    const mod = await import('../dist/cli.js')
    expect(mod).toBeTruthy()
  })
})
