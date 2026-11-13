export function computeBufferRms(buffer: AudioBuffer): number {
  const data = buffer.getChannelData(0);
  const len = data.length;
  if (len === 0) return 0.2;
  let sumSq = 0;
  for (let i = 0; i < len; i++) {
    const v = data[i];
    sumSq += v * v;
  }
  return Math.max(1e-4, Math.sqrt(sumSq / len));
}

export function conditionPeriodicLoopBuffer(
  ctx: AudioContext,
  rawBuffer: AudioBuffer,
  freqHz: number
): AudioBuffer {
  const sr = rawBuffer.sampleRate;
  const src = rawBuffer.getChannelData(0);
  const totalLen = src.length;
  const safeFreq = Math.max(15, Number.isFinite(freqHz) ? freqHz : 45);
  const P = Math.max(64, Math.round(sr / safeFreq));
  if (totalLen < P * 3) return rawBuffer;

  const margin = Math.min(1536, Math.floor(totalLen / 6));
  const searchEnd = Math.min(Math.floor(totalLen / 2), margin + P * 3);
  let zc = margin;
  for (let i = Math.max(1, margin); i < searchEnd; i++) {
    if (src[i - 1] <= 0 && src[i] > 0) {
      zc = i;
      break;
    }
  }
  const avail = totalLen - margin - zc - P;
  const K = Math.max(1, Math.floor(avail / P));
  const L = K * P;
  const xfLen = Math.min(Math.floor(L / 4), P * 3);
  const outBuffer = ctx.createBuffer(1, L, sr);
  const out = outBuffer.getChannelData(0);
  for (let n = 0; n < xfLen; n++) {
    const alpha = 0.5 * (1.0 - Math.cos((Math.PI * n) / xfLen));
    out[n] = (1.0 - alpha) * src[zc + L - xfLen + P + n] + alpha * src[zc + n];
  }
  for (let n = xfLen; n < L; n++) {
    out[n] = src[zc + n];
  }
  return outBuffer;
}

export function createReversedLoopBuffer(
  ctx: AudioContext,
  forwardBuffer: AudioBuffer
): AudioBuffer {
  const len = forwardBuffer.length;
  const revBuffer = ctx.createBuffer(1, len, forwardBuffer.sampleRate);
  const src = forwardBuffer.getChannelData(0);
  const dst = revBuffer.getChannelData(0);
  for (let i = 0; i < len; i++) {
    dst[i] = src[len - 1 - i];
  }
  return revBuffer;
}
