class FFT2D {
  constructor(n) {
    if (n & (n - 1)) throw new Error("FFT size must be a power of two");
    this.n = n;
    this.rev = new Uint32Array(n);
    let bits = 0;
    while ((1 << bits) < n) bits++;
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    this.tre = new Float64Array(n);
    this.tim = new Float64Array(n);
  }

  line(re, im, off, inverse) {
    const n = this.n, rev = this.rev, cs = this.cos, sn = this.sin;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        const a = off + i, b = off + j;
        let t = re[a]; re[a] = re[b]; re[b] = t;
        t = im[a]; im[a] = im[b]; im[b] = t;
      }
    }
    const sign = inverse ? 1 : -1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        let idx = 0;
        for (let k = 0; k < half; k++) {
          const wr = cs[idx], wi = sign * sn[idx];
          const a = off + start + k, b = a + half;
          const xr = re[b], xi = im[b];
          const tr = xr * wr - xi * wi;
          const ti = xr * wi + xi * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
          idx += step;
        }
      }
    }
    if (inverse) {
      const s = 1 / n;
      for (let i = 0; i < n; i++) { re[off + i] *= s; im[off + i] *= s; }
    }
  }

  transform(re, im, inverse) {
    const n = this.n, tre = this.tre, tim = this.tim;
    for (let r = 0; r < n; r++) this.line(re, im, r * n, inverse);
    for (let c = 0; c < n; c++) {
      for (let r = 0, k = c; r < n; r++, k += n) { tre[r] = re[k]; tim[r] = im[k]; }
      this.line(tre, tim, 0, inverse);
      for (let r = 0, k = c; r < n; r++, k += n) { re[k] = tre[r]; im[k] = tim[r]; }
    }
  }
}

function unpackTwoReal(zre, zim, n, are, aim, bre, bim) {
  for (let r = 0; r < n; r++) {
    const rr = (n - r) % n;
    for (let c = 0; c < n; c++) {
      const cc = (n - c) % n;
      const k = r * n + c, kk = rr * n + cc;
      const zr = zre[k], zi = zim[k], wr = zre[kk], wi = -zim[kk];
      are[k] = 0.5 * (zr + wr);
      aim[k] = 0.5 * (zi + wi);
      bre[k] = 0.5 * (zi - wi);
      bim[k] = -0.5 * (zr - wr);
    }
  }
}

if (typeof module !== "undefined") module.exports = { FFT2D, unpackTwoReal };
