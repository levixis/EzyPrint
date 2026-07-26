/**
 * Notification sound utility for web.
 * Plays a pleasant chime when a new order arrives for the shop owner.
 * Uses Web Audio API to generate sounds programmatically — no external files needed.
 */

let audioContext: AudioContext | null = null;
const debugLog = (...args: unknown[]) => {
  void args;
};

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!audioContext) {
    try {
      audioContext = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    } catch {
      debugLog('[Sound] Web Audio API not available');
      return null;
    }
  }
  return audioContext;
}

/**
 * Play a pleasant two-tone notification chime.
 * Works on both desktop and mobile web browsers.
 */
export function playNewOrderSound(): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  // Resume context if suspended (browsers require user interaction first)
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }

  const now = ctx.currentTime;

  // Create a pleasant two-note chime (C5 → E5)
  const notes = [
    { freq: 523.25, start: 0, duration: 0.15 },     // C5
    { freq: 659.25, start: 0.18, duration: 0.25 },   // E5
  ];

  notes.forEach(({ freq, start, duration }) => {
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();

    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(freq, now + start);

    // Smooth attack and decay envelope
    gainNode.gain.setValueAtTime(0, now + start);
    gainNode.gain.linearRampToValueAtTime(0.3, now + start + 0.02);   // Quick attack
    gainNode.gain.exponentialRampToValueAtTime(0.01, now + start + duration); // Smooth decay

    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    oscillator.start(now + start);
    oscillator.stop(now + start + duration + 0.05);
  });

  // Second set of notes (repeat with slight variation for emphasis)
  const notes2 = [
    { freq: 659.25, start: 0.55, duration: 0.15 },   // E5
    { freq: 783.99, start: 0.73, duration: 0.35 },   // G5 (higher, longer)
  ];

  notes2.forEach(({ freq, start, duration }) => {
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();

    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(freq, now + start);

    gainNode.gain.setValueAtTime(0, now + start);
    gainNode.gain.linearRampToValueAtTime(0.25, now + start + 0.02);
    gainNode.gain.exponentialRampToValueAtTime(0.01, now + start + duration);

    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    oscillator.start(now + start);
    oscillator.stop(now + start + duration + 0.05);
  });
}

/**
 * Initialize the audio context on user interaction.
 * Call this once on a user click/tap to unlock audio on mobile browsers.
 */
export function initAudioContext(): void {
  const ctx = getAudioContext();
  if (ctx && ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }
}
