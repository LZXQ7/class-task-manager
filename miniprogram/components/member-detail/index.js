const api = require('../../utils/api');
const util = require('../../utils/util');

/**
 * 成员详情卡（首页就地弹出，自包含）
 * ============================================================
 * 辅导员在首页点「固定到主页」的学生时，直接弹出这张卡片，不再跳成员与分组页。
 * 组件自己拉数据（成员 / 备注 / 固定态）、自己管状态，首页只需传 show / memberId / classId，
 * 并监听 close（收起）与 changed（写操作成功后刷新关注列表）。
 * 口径与 pages/roster 的成员详情一致（见 _load / onTogglePin / onNoteSave 等）。
 *
 * 🔴 v1.0.8.41 切人串档修复（用户真机：关掉 A 再点 B，卡片先显示 A，~500ms 才刷成 B）：
 *   ① 打开 / 换人时**同步清空**上一个人的 mDetail / 备注 / 草稿 / 固定态 —— 否则
 *      异步 memberList 回来之前，wx:if="{{mDetail}}" 一直渲染上一个人；
 *   ② 用 `observers:{'show, memberId, classId'}` 取代两个 property observer —— 同批
 *      setData 只触发一次，不再并发发两次 memberList；
 *   ③ 每次输入变化 _reqSeq++，所有异步回调校验代次 —— 关闭 / 快速换人时旧请求
 *      晚到不会覆盖新学生（也顺带挡住旧的 noteList / pinList 回包串人）；
 *   ④ 关闭时**不清数据**，保留内容给 bottom-sheet 的 240ms 退出动画，仅作废旧请求。
 *   ⑤ 首页把被点学生姓名一并传进来，加载占位首帧就显示「新学生姓名 · 正在加载」，
 *      而不是一片空白或上一个人的信息。
 */
Component({
  options: { addGlobalClass: true, multipleSlots: true },

  properties: {
    show: { type: Boolean, value: false },
    memberId: { type: Number, value: 0 },
    classId: { type: Number, value: 0 },   // 0 = 本班
    memberName: { type: String, value: '' }
  },

  data: {
    mDetail: null,
    loadFailed: false,
    noteVisible: true,   // 组件仅辅导员使用，恒 true
    noteList: [],
    noteDraft: '',
    noteEditId: 0,
    noteBusy: false,
    pinBusy: false,
    pinned: false,
    mDetailIsSelf: false
  },

  lifetimes: {
    attached() {
      // 初始化时数据监听器也会触发一次，_lastKey 去重，避免重复发请求
      this._onInput(this.properties.show, this.properties.memberId, this.properties.classId);
    }
  },

  /** 多字段一次性监听：首页 setData({show,memberId,classId}) 只走这里一次 */
  observers: {
    'show, memberId, classId'(show, memberId, classId) {
      this._onInput(show, memberId, classId);
    }
  },

  methods: {
    /** 统一入参：带目标班级（0 = 本班），与 roster._payload 同口径 */
    _payload(extra) {
      return Object.assign({ classId: this.properties.classId }, extra || {});
    },

    /**
     * 打开 / 换人 / 关闭的唯一入口。
     * ⚠️ 清空必须在发起请求**之前同步**做完：setData 是同步改 data 的，下一拍渲染
     *    拿到的就是清空后的状态，绝不会把上一个人的姓名/备注画进新卡片。
     */
    _onInput(show, memberId, classId) {
      const id = Number(memberId) || 0;
      const key = (show ? 1 : 0) + ':' + id + ':' + (Number(classId) || 0);
      if (key === this._lastKey) return;
      this._lastKey = key;

      // 任何输入变化都作废在途请求：关闭、换人、跨班都算
      this._reqSeq = (this._reqSeq || 0) + 1;
      const seq = this._reqSeq;

      // 关闭：保留内容给 240ms 退出动画（此时清空会让卡片先变空白再消失），只作废请求
      if (!show) return;

      this.setData({
        mDetail: null,
        mDetailIsSelf: false,
        loadFailed: false,
        noteList: [],
        noteDraft: '',
        noteEditId: 0,
        noteBusy: false,
        pinBusy: false,
        pinned: false
      });
      if (id > 0) this._load(seq, id);
    },

    /** 打开 / 换人时拉全量：成员详情 + 备注 + 固定态（带请求代次） */
    _load(seq, id) {
      const memberId = Number(id) || 0;
      if (!(memberId > 0)) return;
      const self = this;
      api.memberList(this._payload({ public: 'manage' }), { toast: false })
        .then((list) => {
          if (seq !== self._reqSeq) return;      // 已经关掉 / 换人，旧回包直接丢弃
          const hit = (list || []).find(x => Number(x.id) === memberId);
          if (hit == null) {
            util.toast('未找到该成员');
            self.setData({ mDetail: null, loadFailed: true });
            return;
          }
          const app = getApp && getApp();
          const me = (app && app.globalData && app.globalData.profile) || null;
          const m = Object.assign({}, hit, { seq: util.seqOf(hit.studentNo) });
          self.setData({
            mDetail: m,
            mDetailIsSelf: !!(me && Number(me.id) === Number(m.id)),
            noteList: [],
            noteDraft: '',
            noteEditId: 0,
            pinned: false
          });
          self._loadNotes(seq, memberId);
          self._loadPinState(seq, memberId);
        })
        .catch((e) => {
          if (seq !== self._reqSeq) return;
          console.error('[member-detail] 加载成员失败', e);
          self.setData({ loadFailed: true });
          util.toast('加载成员失败');
        });
    },

    _loadNotes(seq, memberId) {
      api.noteList({ memberId }, { toast: false })
        .then((list) => {
          if (seq !== this._reqSeq) return;      // 备注也不能串到下一个人
          this.setData({
            noteList: (list || []).map(x => Object.assign({}, x, {
              createdAtText: String(x.createdAt || '').replace('T', ' ').slice(5, 16)
            }))
          });
        })
        .catch((e) => {
          if (seq !== this._reqSeq) return;
          console.error('[member-detail] 加载备注失败', e);
        });
    },

    _loadPinState(seq, memberId) {
      api.pinList({}, { toast: false })
        .then((r) => {
          if (seq !== this._reqSeq) return;
          const list = (r && r.list) || [];
          this.setData({
            pinned: list.some(x => Number(x.memberId) === Number(memberId))
          });
        })
        .catch((e) => {
          if (seq !== this._reqSeq) return;
          console.error('[member-detail] 加载固定状态失败', e);
        });
    },

    /** bottom-sheet 的 close（点遮罩空白处 / 拖拽关闭）→ 转发给首页收起 */
    onClose() {
      this.triggerEvent('close');
    },

    onTogglePin() {
      const m = this.data.mDetail;
      if (m == null || this.data.pinBusy) return;
      this.setData({ pinBusy: true });
      api.pinToggle({ memberId: m.id }, { toast: false })
        .then((r) => {
          const nowPinned = !!(r && r.pinned);
          this.setData({ pinBusy: false, pinned: nowPinned });
          util.toast(nowPinned ? '已固定到主页' : '已取消固定');
          this.triggerEvent('changed');
        })
        .catch((e) => {
          this.setData({ pinBusy: false });
          util.toast((e && e.errMsg) || '操作失败');
        });
    },

    onToggleGroup() {
      const m = this.data.mDetail;
      if (m == null || this.data.mDetailIsSelf) return;
      const tag = m.groupTag === 'A' ? 'B' : 'A';
      api.updateGroup(this._payload({ memberId: m.id, groupTag: tag }), { loading: '处理中' })
        .then(() => {
          util.toast('已调整到 ' + tag + ' 组');
          this.triggerEvent('changed');
          this.triggerEvent('close');
        })
        .catch((e) => {
          console.error('[member-detail] 调组失败', e);
          util.toast((e && e.errMsg) || '操作失败');
        });
    },

    /* v1.0.8.39：首页就地卡不再提供「停用 / 恢复」入口，对应 onToggleStatus 一并删除
       （留着就是死代码，且容易被后来者误接回 WXML）。停用只在 pages/roster 做。 */

    onNoteInput(e) {
      this.setData({ noteDraft: e.detail.value });
    },

    /** 点自己写的备注 = 载入草稿改为编辑（保存走 noteSave 带 id） */
    onNoteEdit(e) {
      const id = Number(e.currentTarget.dataset.id) || 0;
      const hit = (this.data.noteList || []).find(x => Number(x.id) === id);
      if (hit == null) return;
      this.setData({ noteEditId: id, noteDraft: hit.content });
    },

    onNoteCancel() {
      this.setData({ noteEditId: 0, noteDraft: '' });
    },

    onNoteSave() {
      const m = this.data.mDetail;
      if (m == null || this.data.noteBusy) return;
      const content = String(this.data.noteDraft || '').trim();
      if (!content) { util.toast('备注内容不能为空'); return; }
      this.setData({ noteBusy: true });
      api.noteSave(
        { memberId: m.id, content, id: this.data.noteEditId || undefined },
        { loading: '保存中' }
      )
        .then(() => {
          this.setData({ noteBusy: false, noteDraft: '', noteEditId: 0 });
          util.toast('备注已保存');
          this._loadNotes(this._reqSeq, m.id);
          this.triggerEvent('changed');
        })
        .catch((e) => {
          this.setData({ noteBusy: false });
          util.toast((e && e.errMsg) || '保存失败');
        });
    },

    onNoteDelete(e) {
      const id = Number(e.currentTarget.dataset.id) || 0;
      if (!(id > 0)) return;
      util.confirm('删除这条备注？', '删除备注').then((ok) => {
        if (!ok) return;
        api.noteDelete({ id }, { loading: '删除中' })
          .then(() => {
            util.toast('已删除');
            const m = this.data.mDetail;
            if (m != null) this._loadNotes(this._reqSeq, m.id);
            this.triggerEvent('changed');
          })
          .catch((err) => util.toast((err && err.errMsg) || '删除失败'));
      });
    }
  }
});
