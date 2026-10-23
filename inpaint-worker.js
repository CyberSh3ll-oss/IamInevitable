// Background generation worker. Runs the MI-GAN inpainting model (ONNX Runtime
// Web, WASM backend) off the engine's main thread, so filling in the room
// behind you never stalls the video.
//
// Input:  { id, rgba: Uint8ClampedArray(512*512*4), hole: Uint8Array(512*512) }
//         hole[i] = 1 where the background is unknown and must be generated.
// Output: { id, rgba: Uint8ClampedArray(512*512*4), ms } or { id, error }

import * as ort from '../lib/ort/ort.wasm.bundle.min.mjs';

const SIZE = 512;
ort.env.wasm.numThreads = 1; // extension pages are not cross-origin isolated
ort.env.wasm.wasmPaths = { wasm: new URL('../lib/ort/ort-wasm-simd-threaded.wasm', import.meta.url).href };

let session = null;
const getSession = () =>
  (session ||= ort.InferenceSession.create(new URL('../models/migan_512.onnx', import.meta.url).href, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  }));

self.onmessage = async (e) => {
  const { id, rgba, hole } = e.data;
  try {
    const s = await getSession();
    const N = SIZE * SIZE;
    // MI-GAN input: [0.5 - mask, erased RGB in -1..1]
    const input = new Float32Array(4 * N);
    for (let i = 0; i < N; i++) {
      const m = hole[i];
      const keep = 1 - m;
      input[i] = 0.5 - m;
      input[N + i] = (rgba[i * 4] / 127.5 - 1) * keep;
      input[2 * N + i] = (rgba[i * 4 + 1] / 127.5 - 1) * keep;
      input[3 * N + i] = (rgba[i * 4 + 2] / 127.5 - 1) * keep;
    }
    const t0 = performance.now();
    const out = await s.run({ input: new ort.Tensor('float32', input, [1, 4, SIZE, SIZE]) });
    const ms = performance.now() - t0;
    const y = out.output.data;
    const res = new Uint8ClampedArray(N * 4);
    for (let i = 0; i < N; i++) {
      res[i * 4] = (y[i] + 1) * 127.5;
      res[i * 4 + 1] = (y[N + i] + 1) * 127.5;
      res[i * 4 + 2] = (y[2 * N + i] + 1) * 127.5;
      res[i * 4 + 3] = 255;
    }
    self.postMessage({ id, rgba: res, ms }, [res.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
