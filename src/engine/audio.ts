// 100% Procedural Open-Source Web Audio Synthesizer for Abyssal Evo
// Respects MyPC lifecycle: created only after user/onStart gesture, muted onPause, closed onDestroy.

class AquariumAudioEngine {
  private ctx: AudioContext | null = null;
  private musicVolume = 0.7;
  private sfxVolume = 0.8;
  private muted = false;
  private ambientInterval: number | null = null;

  public initOrResume(): void {
    if (typeof window === 'undefined') return;
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    if (!this.ctx) {
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    this.startAmbientChimes();
  }

  public setVolumes(music: number, sfx: number): void {
    this.musicVolume = Math.max(0, Math.min(1, music));
    this.sfxVolume = Math.max(0, Math.min(1, sfx));
  }

  public setMuted(mute: boolean): void {
    this.muted = mute;
  }

  public isMuted(): boolean {
    return this.muted;
  }

  public pause(): void {
    if (this.ambientInterval !== null) {
      window.clearInterval(this.ambientInterval);
      this.ambientInterval = null;
    }
    if (this.ctx && this.ctx.state === 'running') {
      this.ctx.suspend().catch(() => {});
    }
  }

  public resume(): void {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    this.startAmbientChimes();
  }

  public destroy(): void {
    if (this.ambientInterval !== null) {
      window.clearInterval(this.ambientInterval);
      this.ambientInterval = null;
    }
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }

  private startAmbientChimes(): void {
    if (this.ambientInterval !== null || typeof window === 'undefined') return;
    // Play a gentle pentatonic hydrophone harmonic note every 4.5 seconds for the TV screensaver atmosphere
    const notes = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25];
    this.ambientInterval = window.setInterval(() => {
      if (this.muted || !this.ctx || this.ctx.state !== 'running' || this.musicVolume <= 0.02) {
        return;
      }
      const freq = notes[Math.floor(Math.random() * notes.length)];
      this.playTone(freq, 1.8, 'sine', this.musicVolume * 0.08);
    }, 4500);
  }

  private lastPelletDropMs = 0;
  private lastPelletEatMs = 0;

  public playPelletDrop(): void {
    const now = performance.now();
    if (now - this.lastPelletDropMs < 140) return;
    this.lastPelletDropMs = now;
    this.playTone(580, 0.12, 'sine', this.sfxVolume * 0.22, 320);
  }

  public playPelletEat(): void {
    const now = performance.now();
    if (now - this.lastPelletEatMs < 140) return;
    this.lastPelletEatMs = now;
    this.playTone(420 + Math.random() * 120, 0.09, 'triangle', this.sfxVolume * 0.18, 680);
  }

  public playBirthChime(): void {
    this.playTone(523.25, 0.22, 'sine', this.sfxVolume * 0.25, 783.99);
  }

  public playTankUpgrade(): void {
    this.playTone(440, 0.35, 'triangle', this.sfxVolume * 0.3, 880);
  }

  private playTone(
    startFreq: number,
    durationSec: number,
    type: OscillatorType,
    gainLevel: number,
    endFreq?: number
  ): void {
    if (this.muted || gainLevel <= 0.005 || typeof window === 'undefined') return;
    window.setTimeout(() => {
      try {
        if (this.muted) return;
        this.initOrResume();
        if (!this.ctx || this.ctx.state !== 'running') return;

        const now = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(startFreq, now);
        if (endFreq) {
          osc.frequency.exponentialRampToValueAtTime(endFreq, now + durationSec);
        }

        gain.gain.setValueAtTime(0.001, now);
        gain.gain.linearRampToValueAtTime(gainLevel, now + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0008, now + durationSec);

        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.onended = () => {
          try {
            osc.disconnect();
            gain.disconnect();
          } catch {
            // ignore
          }
        };
        osc.start(now);
        osc.stop(now + durationSec + 0.02);
      } catch {
        // ignore audio errors
      }
    }, 0);
  }
}

export const audioEngine = new AquariumAudioEngine();
