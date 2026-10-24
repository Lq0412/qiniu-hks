export class VoiceAudio {
  constructor() { this.context = null; this.stream = null; this.node = null; this.sources = new Set(); this.nextAt = 0; this.rate = 24000; this.closed = false; }
  async init(onPacket) {
    try {
      const context = this.context = new AudioContext({ sampleRate: 48000 });
      await context.resume();
      if (this.closed) throw new Error('语音连接已取消。');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
      if (this.closed) { stream.getTracks().forEach(t => t.stop()); throw new Error('语音连接已取消。'); }
      this.stream = stream;
      await context.audioWorklet.addModule('/recorder.js');
      if (this.closed) throw new Error('语音连接已取消。');
      this.node = new AudioWorkletNode(context, 'recorder');
      this.node.port.onmessage = e => onPacket(e.data);
      const mic = this.context.createMediaStreamSource(this.stream);
      const muted = this.context.createGain(); muted.gain.value = 0;
      mic.connect(this.node); this.node.connect(muted); muted.connect(this.context.destination);
    } catch (error) { this.close(); throw error; }
  }
  record(active) { this.node?.port.postMessage(active); }
  play(packet) {
    if (!this.context || packet.byteLength % 2) return;
    const data = new DataView(packet); const buffer = this.context.createBuffer(1, packet.byteLength / 2, this.rate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < channel.length; i++) channel[i] = data.getInt16(i * 2, true) / 32768;
    const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.context.destination);
    const start = Math.max(this.context.currentTime + .02, this.nextAt);
    this.nextAt = start + buffer.duration;
    this.sources.add(source); source.onended = () => this.sources.delete(source); source.start(start);
  }
  stop() { for (const s of this.sources) s.stop(); this.sources.clear(); this.nextAt = 0; }
  releaseMic() { this.stream?.getTracks().forEach(t => t.stop()); this.node?.disconnect(); this.stream = null; this.node = null; }
  remainingMs() { return this.context ? Math.max(0, this.nextAt - this.context.currentTime) * 1000 : 0; }
  close() { this.closed = true; this.stop(); this.releaseMic(); if (this.context?.state !== 'closed') this.context?.close(); this.context = null; }
}
