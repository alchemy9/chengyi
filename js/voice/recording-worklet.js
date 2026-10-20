// 录音：把麦克风的 16kHz 采样分块交给页面，页面拼成 WAV 发给后台转写。复制自 server/app/static/recording-worklet.js。
class HeritageRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(2048);
    this.offset = 0;
    this.port.onmessage = event => {
      if (event.data === 'flush') {
        if (this.offset) this.port.postMessage(this.buffer.slice(0, this.offset));
        this.offset = 0;
        this.port.postMessage({flushed: true});
      }
    };
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) {
      for (const sample of channel) {
        this.buffer[this.offset++] = sample;
        if (this.offset === this.buffer.length) {
          this.port.postMessage(this.buffer, [this.buffer.buffer]);
          this.buffer = new Float32Array(2048);
          this.offset = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('heritage-recorder', HeritageRecorder);
