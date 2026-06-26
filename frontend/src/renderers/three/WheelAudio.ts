// The wheel's feedback layer: peg-tick + landing-thunk audio over a compressed
// master bus, plus mute-gated haptic pulses. Extracted from ThreeWheelRenderer
// so the audio/haptics concern is a self-contained collaborator with no three.js
// or scene dependency (and can be driven with a fake AudioContext in a test).
export class WheelAudio {
  private ctx: AudioContext | null = null
  private masterGain: GainNode | null = null
  private resumeHandler: (() => void) | null = null
  private muted = false

  constructor(muted = false) {
    this.muted = muted
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)()
      this.ctx = ctx
      // Master bus: ticks/thunk -> masterGain -> compressor -> destination, so
      // overlapping ticks have headroom and never clip.
      this.masterGain = ctx.createGain()
      this.masterGain.gain.value = 0.9
      const comp = ctx.createDynamicsCompressor()
      this.masterGain.connect(comp)
      comp.connect(ctx.destination)
      // Browsers start the context suspended until a user gesture; resume on the
      // first pointer/key so early ticks aren't silently dropped.
      const resume = () => {
        if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {})
        this.unbindResume()
      }
      this.resumeHandler = resume
      window.addEventListener('pointerdown', resume)
      window.addEventListener('keydown', resume)
    } catch {}
  }

  private unbindResume() {
    if (this.resumeHandler) {
      window.removeEventListener('pointerdown', this.resumeHandler)
      window.removeEventListener('keydown', this.resumeHandler)
      this.resumeHandler = null
    }
  }

  setMuted(m: boolean) {
    this.muted = m
  }

  // Rising-pitch tick: pitch climbs with spin progress (a drumroll into the
  // landing); boost lifts the volume for the final dramatic ticks.
  tick(progress = 0, boost = false) {
    if (this.muted || !this.ctx || !this.masterGain) return
    try {
      const ctx = this.ctx
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = 'square'
      const clamped = progress < 0 ? 0 : progress > 1 ? 1 : progress
      o.frequency.value = 660 + clamped * 540 // 660Hz -> 1200Hz across the spin
      const peak = boost ? 0.05 : 0.03
      const now = ctx.currentTime
      // Short percussive envelope (attack + exponential decay on the audio clock)
      // instead of a hard setTimeout cutoff, which clicked at each tick end.
      g.gain.setValueAtTime(0.0001, now)
      g.gain.exponentialRampToValueAtTime(peak, now + 0.005)
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.05)
      o.connect(g)
      g.connect(this.masterGain)
      o.start(now)
      o.stop(now + 0.06)
    } catch {}
  }

  thunk() {
    if (this.muted || !this.ctx || !this.masterGain) return
    try {
      const ctx = this.ctx
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = 'sine'
      o.frequency.value = 140
      const now = ctx.currentTime
      g.gain.setValueAtTime(0.0001, now)
      g.gain.exponentialRampToValueAtTime(0.3, now + 0.01)
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.18)
      o.connect(g)
      g.connect(this.masterGain)
      o.start(now)
      o.stop(now + 0.2)
    } catch {}
  }

  // Haptic pulse, gated by the same mute flag as audio. navigator.vibrate is a
  // no-op on desktop / unsupported, so this is safe to call unconditionally.
  vibrate(pattern: number | number[]) {
    if (this.muted) return
    try {
      if (typeof navigator !== 'undefined' && (navigator as any).vibrate) (navigator as any).vibrate(pattern)
    } catch {}
  }

  dispose() {
    this.unbindResume()
    if (this.ctx) this.ctx.close().catch(() => {})
    this.ctx = null
    this.masterGain = null
  }
}
