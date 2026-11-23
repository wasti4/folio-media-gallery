import { useLayoutEffect, useRef, useState } from 'react'
import { luminanceWeights, photoGeometry, photoLookup, sharpWeight } from '../shared/photo-look.mjs'

const vertexSource = `#version 300 es
void main() {
  vec2 vertices[3] = vec2[3](vec2(-1, -1), vec2(3, -1), vec2(-1, 3));
  gl_Position = vec4(vertices[gl_VertexID], 0, 1);
}
`

const fragmentSource = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D photo;
uniform sampler2D lut;
uniform ivec2 size;
uniform ivec2 origin;
uniform ivec2 column;
uniform ivec2 row;
uniform float sharpness;
uniform float saturation;
uniform vec3 luminance;
out vec4 pixel;

vec4 samplePhoto(ivec2 coord) {
  ivec2 position = clamp(coord, ivec2(0), size - 1);
  return texelFetch(photo, origin + position.x * column + position.y * row, 0);
}

void main() {
  ivec2 p = ivec2(int(gl_FragCoord.x), size.y - 1 - int(gl_FragCoord.y));
  vec4 source = samplePhoto(p);
  vec3 color = source.rgb;
  if (sharpness > 0.0) {
    vec3 around = samplePhoto(p + ivec2(1, 0)).rgb + samplePhoto(p - ivec2(1, 0)).rgb
      + samplePhoto(p + ivec2(0, 1)).rgb + samplePhoto(p - ivec2(0, 1)).rgb;
    color = floor(clamp(color + (4.0 * color - around) * sharpness, 0.0, 1.0) * 255.0 + 0.5) / 255.0;
  }
  color = mix(vec3(dot(color, luminance)), color, saturation);
  ivec3 index = ivec3(clamp(color, 0.0, 1.0) * 255.0 + 0.5);
  pixel = vec4(texelFetch(lut, ivec2(index.r, 0), 0).r, texelFetch(lut, ivec2(index.g, 0), 0).g,
    texelFetch(lut, ivec2(index.b, 0), 0).b, source.a);
}
`

function compile(gl, kind, source) {
  const shader = gl.createShader(kind)
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader)
    throw new Error('Photo preview shader could not compile')
  }
  return shader
}

function webglPreview(canvas, image, gl) {
  const program = gl.createProgram()
  const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource)
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource)
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program)
    throw new Error('Photo preview program could not link')
  }
  gl.useProgram(program)
  const uniforms = Object.fromEntries(['photo', 'lut', 'size', 'origin', 'column', 'row', 'sharpness', 'saturation', 'luminance']
    .map(name => [name, gl.getUniformLocation(program, name)]))

  function texture(unit) {
    const value = gl.createTexture()
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, value)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return value
  }
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
  const source = texture(0)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
  const table = texture(1)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
  gl.uniform1i(uniforms.photo, 0)
  gl.uniform1i(uniforms.lut, 1)
  gl.uniform3fv(uniforms.luminance, luminanceWeights)

  return {
    draw(edit, { width, height, origin, column, row }) {
      if (canvas.width !== width) canvas.width = width
      if (canvas.height !== height) canvas.height = height
      gl.viewport(0, 0, width, height)
      gl.uniform2i(uniforms.size, width, height)
      gl.uniform2iv(uniforms.origin, origin)
      gl.uniform2iv(uniforms.column, column)
      gl.uniform2iv(uniforms.row, row)
      gl.uniform1f(uniforms.sharpness, sharpWeight(edit.sharpness))
      gl.uniform1f(uniforms.saturation, 1 + edit.saturation / 100)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(photoLookup(edit).buffer))
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    },
    dispose() {
      gl.deleteTexture(source)
      gl.deleteTexture(table)
      gl.deleteProgram(program)
    },
  }
}

const byte = value => Math.max(0, Math.min(255, Math.round(value)))

function canvasPreview(canvas, image) {
  const context = canvas.getContext('2d')
  const source = document.createElement('canvas')
  source.width = image.naturalWidth ?? image.width
  source.height = image.naturalHeight ?? image.height
  const reader = source.getContext('2d', { willReadFrequently: true })
  reader.drawImage(image, 0, 0)
  const pixels = reader.getImageData(0, 0, source.width, source.height).data
  const stride = source.width
  const offset = ([x, y]) => (x + y * stride) * 4
  let result
  return {
    draw(edit, { width, height, origin, column, row }) {
      if (!result || result.width !== width || result.height !== height) {
        canvas.width = width
        canvas.height = height
        result = context.createImageData(width, height)
      }
      const lookup = photoLookup(edit)
      const saturation = edit.saturation / 100
      const sharpness = sharpWeight(edit.sharpness)
      const [red, green, blue] = luminanceWeights
      const first = offset(origin)
      const dx = offset(column)
      const dy = offset(row)
      let written = 0
      for (let y = 0; y < height; y++) {
        const up = y > 0 ? -dy : 0
        const down = y + 1 < height ? dy : 0
        let index = first + y * dy
        for (let x = 0; x < width; x++, index += dx) {
          let r = pixels[index], g = pixels[index + 1], b = pixels[index + 2]
          if (sharpness) {
            const left = index - (x > 0 ? dx : 0)
            const right = index + (x + 1 < width ? dx : 0)
            const above = index + up
            const below = index + down
            r = byte(r + (r * 4 - pixels[left] - pixels[right] - pixels[above] - pixels[below]) * sharpness)
            g = byte(g + (g * 4 - pixels[left + 1] - pixels[right + 1] - pixels[above + 1] - pixels[below + 1]) * sharpness)
            b = byte(b + (b * 4 - pixels[left + 2] - pixels[right + 2] - pixels[above + 2] - pixels[below + 2]) * sharpness)
          }
          const gray = r * red + g * green + b * blue
          result.data[written++] = lookup[byte(r + (r - gray) * saturation) * 4]
          result.data[written++] = lookup[byte(g + (g - gray) * saturation) * 4 + 1]
          result.data[written++] = lookup[byte(b + (b - gray) * saturation) * 4 + 2]
          result.data[written++] = pixels[index + 3]
        }
      }
      context.putImageData(result, 0, 0)
    },
  }
}

export function privateEditPreview(image, maxWidth = 1152, maxHeight = 900) {
  const scale = Math.min(1, maxWidth / image.naturalWidth, maxHeight / image.naturalHeight)
  if (scale === 1) return image
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height)
  return canvas
}

export function encodePrivateEdit(image, edit) {
  const geometry = photoGeometry(image.naturalWidth, image.naturalHeight, edit)
  let canvas = document.createElement('canvas')
  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true })
  const largest = Math.max(image.naturalWidth, image.naturalHeight)
  let painter
  try {
    if (gl && largest <= gl.getParameter(gl.MAX_TEXTURE_SIZE) && largest <= gl.getParameter(gl.MAX_RENDERBUFFER_SIZE)) {
      try {
        painter = webglPreview(canvas, image, gl)
        painter.draw(edit, geometry)
        if (gl.getError() === gl.NO_ERROR && gl.drawingBufferWidth === geometry.width && gl.drawingBufferHeight === geometry.height) {
          return canvas.toDataURL('image/png')
        }
      } catch { /* The software painter handles devices with restricted WebGL buffers. */ }
    }
    canvas.width = canvas.height = 1
    canvas = document.createElement('canvas')
    canvasPreview(canvas, image).draw(edit, geometry)
    return canvas.toDataURL('image/png')
  } finally {
    painter?.dispose()
    canvas.width = canvas.height = 1
  }
}

export function PhotoPreview({ image, edit, geometry, label }) {
  const element = useRef(null)
  const painter = useRef(null)
  const pending = useRef(null)
  const animation = useRef(0)
  const [software, setSoftware] = useState(false)
  const signature = JSON.stringify([edit, geometry])

  function schedule() {
    if (animation.current || !painter.current) return
    animation.current = requestAnimationFrame(() => {
      animation.current = 0
      if (!painter.current || !pending.current) return
      const { edit, geometry } = pending.current
      painter.current.draw(edit, geometry)
      if (element.current) element.current.dataset.ready = 'true'
    })
  }

  useLayoutEffect(() => {
    pending.current = { edit, geometry }
    schedule()
  }, [signature])

  useLayoutEffect(() => {
    const canvas = element.current
    const recover = event => {
      event.preventDefault()
      setSoftware(true)
    }
    const gl = !software && canvas.getContext('webgl2', {
      alpha: true, premultipliedAlpha: false, antialias: false, depth: false, stencil: false,
    })
    try {
      painter.current = gl ? webglPreview(canvas, image, gl) : canvasPreview(canvas, image)
    } catch (error) {
      if (gl) setSoftware(true)
      else throw error
    }
    canvas.addEventListener('webglcontextlost', recover)
    schedule()
    return () => {
      canvas.removeEventListener('webglcontextlost', recover)
      cancelAnimationFrame(animation.current)
      animation.current = 0
      painter.current?.dispose?.()
      painter.current = null
    }
  }, [image, software])

  return <canvas key={software ? 'cpu' : 'default'} ref={element} aria-label={label} role="img" />
}
