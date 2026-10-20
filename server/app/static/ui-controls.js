// A reference client for the backend's finite set of interface actions.
class HeritageUIController {
  constructor({api, getSession, setSession, ensureSession, getItems, getView, setView, playback}) {
    Object.assign(this, {api, getSession, setSession, ensureSession, getItems, getView, setView, playback});
    this.generation = 0;
    this.pending = null;
    this.abort = null;
    this.executed = new Set();
    this.supported = ['open_item', 'focus_hotspot', 'audio_pause', 'audio_resume', 'audio_repeat', 'audio_stop'];
  }
  path(suffix) { return '/sessions/' + this.getSession().id + '/ui/' + suffix; }
  check(generation) {
    if (generation !== this.generation) throw new DOMException('操作已取消', 'AbortError');
  }
  async refresh() {
    await this.ensureSession();
    const sessionId = this.getSession().id;
    const state = await this.api(this.path('state'));
    if (this.getSession()?.id !== sessionId) throw new DOMException('会话已切换', 'AbortError');
    this.setSession(state.session);
    return state;
  }
  showState(session) {
    if (session.current_item_id) this.setView({item_id: session.current_item_id, hotspot_id: session.current_hotspot_id});
  }
  async sync(item_id, hotspot_id = null) {
    const state = await this.refresh();
    const result = await this.api(this.path('context'), 'POST', {
      expected_revision: state.session.revision, item_id, hotspot_id
    });
    this.setSession(result.session);
    this.showState(result.session);
  }
  async receipt(action, status, actual = {}) {
    const payload = {expected_revision: action.expected_revision, status, ...actual};
    const path = this.path('actions/' + action.id + '/receipt');
    try { return await this.api(path, 'POST', payload); }
    catch (error) {
      // A lost acknowledgement can be retried safely with the identical body.
      if (!(error instanceof TypeError)) throw error;
      return await this.api(path, 'POST', payload);
    }
  }
  async run(text) {
    const generation = ++this.generation;
    this.abort = new AbortController();
    const state = await this.refresh();
    this.check(generation);
    const result = await this.api(this.path('plan'), 'POST', {
      text, expected_revision: state.session.revision, client_request_id: crypto.randomUUID(),
      supported_actions: this.supported
    }, {signal: this.abort.signal});
    this.check(generation);
    this.setSession(result.session);
    if (result.decision !== 'action') return result;
    const action = result.action;
    this.pending = action;
    if (this.executed.has(action.id)) return {decision: 'completed', message: '这条操作已经执行。'};
    if (!this.supported.includes(action.type) || action.expected_revision !== result.session.revision || Date.parse(action.expires_at) <= Date.now()) {
      throw Error('收到的界面操作已失效，请重新发出指令。');
    }
    let status = 'applied', playback_state, failure = '';
    try {
      if (action.type === 'open_item' || action.type === 'focus_hotspot') {
        const item = this.getItems().find(item => item.id === action.item_id);
        if (!item) throw Error('当前页面没有这件藏品，请刷新页面。');
        if (action.type === 'focus_hotspot' && !item.hotspots.some(part => part.key === action.hotspot_id)) {
          throw Error('当前页面没有这个部位，请刷新藏品资料。');
        }
        this.setView({item_id: item.id, hotspot_id: action.hotspot_id});
      } else {
        playback_state = await this.playback(action.type);
      }
      this.check(generation);
      this.executed.add(action.id);
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      status = 'failed';
      failure = error.message;
    }
    const actual = this.getView();
    try {
      const acknowledged = await this.receipt(action, status, {
        actual_item_id: actual.item_id, actual_hotspot_id: actual.hotspot_id,
        ...(playback_state ? {playback_state} : {})
      });
      this.check(generation);
      this.pending = null;
      this.setSession(acknowledged.session);
      this.showState(acknowledged.session);
      return {decision: status === 'applied' ? 'completed' : 'clarify',
        message: failure || acknowledged.message, interaction: acknowledged.interaction,
        duplicate: acknowledged.duplicate, action_id: action.id, action_type: action.type};
    } catch (error) {
      // Do not say an operation succeeded if its receipt is unknown or rejected.
      if (generation === this.generation) {
        const latest = await this.refresh().catch(() => null);
        if (latest) this.showState(latest.session);
      }
      throw error;
    }
  }
  async cancel() {
    const generation = ++this.generation;
    this.abort?.abort();
    const state = await this.refresh();
    if (generation !== this.generation) return;
    const result = await this.api(this.path('cancel'), 'POST', {expected_revision: state.session.revision});
    if (generation !== this.generation) return;
    this.setSession(result.session);
    this.showState(result.session);
    this.pending = null;
  }
}
window.HeritageUIController = HeritageUIController;
