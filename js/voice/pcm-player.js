// 边收边播后台推来的 PCM 声音（24kHz 单声道 s16le），不需要先下载整段音频。复制自 server/app/static/pcm-player.js。
export class PCMPlayer {
  constructor({onStart, onFinish, onBlocked} = {}) {
    this.context = null;
    this.sources = new Set();
    this.buffers = [];
    this.generation = 0;
    this.nextAt = 0;
    this.firstAt = null;
    this.started = false;
    this.finished = false;
    this.paused = false;
    this.onStart = onStart;
    this.onFinish = onFinish;
    this.onBlocked = onBlocked;
  }
  unlock() {
    if (!this.context) {
      this.context = new AudioContext({latencyHint: 'interactive'});
      this.context.onstatechange = () => {
        if (this.context?.state === 'running') this.armStart();
      };
    }
    void this.context.resume().then(() => this.armStart()).catch(() => this.onBlocked?.());
  }
  armStart() {
    clearTimeout(this.timer);
    if (this.started || this.firstAt == null || this.paused || this.context?.state !== 'running') return;
    const generation = this.generation;
    this.timer = setTimeout(() => {
      if (generation !== this.generation || this.paused || this.context.state !== 'running') return;
      this.started = true;
      this.onStart?.();
    }, Math.max(0, (this.firstAt - this.context.currentTime) * 1000));
  }
  append(packet) {
    if (packet.encoding !== 'pcm_s16le' || packet.channels !== 1 || packet.sample_rate !== 24000) {
      throw Error('收到的声音格式不受支持，请刷新页面。');
    }
    this.unlockIfMissing();
    const bytes = Uint8Array.from(atob(packet.audio_base64), char => char.charCodeAt(0));
    if (!bytes.length || bytes.length % 2) throw Error('收到的声音片段不完整。');
    const view = new DataView(bytes.buffer);
    const buffer = this.context.createBuffer(1, bytes.length / 2, 24000);
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < channel.length; index++) channel[index] = view.getInt16(index * 2, true) / 32768;
    this.buffers.push(buffer);
    this.schedule(buffer);
    if (!this.paused && this.context.state !== 'running') this.onBlocked?.();
  }
  unlockIfMissing() {
    if (!this.context) this.unlock();
  }
  schedule(buffer) {
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    const generation = this.generation;
    const at = Math.max(this.nextAt, this.context.currentTime + (this.firstAt == null ? 0.12 : 0.025));
    if (this.firstAt == null) this.firstAt = at;
    this.nextAt = at + buffer.duration;
    this.sources.add(source);
    source.onended = () => {
      source.disconnect();
      this.sources.delete(source);
      if (generation === this.generation && !this.sources.size && this.finished) this.onFinish?.();
    };
    source.start(at);
    this.armStart();
  }
  pause() {
    this.paused = true;
    clearTimeout(this.timer);
    if (this.context?.state === 'running') void this.context.suspend().catch(() => {});
  }
  resume() {
    this.paused = false;
    this.unlock();
  }
  replay() {
    if (!this.buffers.length) return;
    this.stopNodes();
    this.nextAt = 0;
    this.firstAt = null;
    this.started = false;
    this.paused = false;
    this.unlock();
    for (const buffer of this.buffers) this.schedule(buffer);
  }
  finish() {
    this.finished = true;
    if (!this.sources.size && this.buffers.length) this.onFinish?.();
  }
  stopNodes() {
    this.generation++;
    clearTimeout(this.timer);
    for (const source of this.sources) {
      source.onended = null;
      try { source.stop(); } catch {}
      source.disconnect();
    }
    this.sources.clear();
  }
  reset() {
    this.stopNodes();
    this.buffers = [];
    this.nextAt = 0;
    this.firstAt = null;
    this.started = false;
    this.finished = false;
    this.paused = false;
  }
  get hasAudio() { return this.buffers.length > 0; }
  destroy() {
    this.reset();
    const context = this.context;
    this.context = null;
    if (context) void context.close().catch(() => {});
  }
}
