// Shader source the capture found is GLSL (WebGL) or WGSL (WebGPU); the two read differently when
// ported, so the prompt labels each piece.
export function isWgsl(code: string): boolean {
  return /@(?:fragment|vertex|compute)\b|@group\(\d+\)|\bfn\s+\w+\s*\([^)]*\)\s*->/.test(code)
}
