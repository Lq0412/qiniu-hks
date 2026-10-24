class Recorder extends AudioWorkletProcessor {
  constructor() { super(); this.buffer = []; this.phase = 0; this.listening = false; this.port.onmessage = e => { this.listening = e.data; this.buffer = []; this.phase = 0; }; }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input || !this.listening) return true;
    // Fractional accumulator keeps the output rate at 16k even on 44.1k devices.
    for (let i = 0; i < input.length; i++) {
      this.phase += 16000;
      if (this.phase >= sampleRate) {
        this.phase -= sampleRate;
        this.buffer.push(Math.max(-32768, Math.min(32767, Math.round(input[i] * 32767))));
        if (this.buffer.length === 320) {
          const packet = new ArrayBuffer(640); const view = new DataView(packet);
          this.buffer.forEach((value, index) => view.setInt16(index * 2, value, true));
          this.port.postMessage(packet, [packet]); this.buffer = [];
        }
      }
    }
    return true;
  }
}
registerProcessor('recorder', Recorder);
