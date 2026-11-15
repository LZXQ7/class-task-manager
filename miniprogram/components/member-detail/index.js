const api = require('../../utils/api');
const util = require('../../utils/util');

/**
 * 成员详情卡（首页就地弹出，自包含）
 * ============================================================
 * 辅导员在首页点「固定到主页」的学生时，直接弹出这张卡片，不再跳成员与分组页。
 * 组件自己拉数据（成员 / 备注 / 固定态）、自己管状态，首页只需传 show / memberId / classId，
 * 并监听 close（收起）与 changed（写操作成功后刷新关注列表）。
 * 口径与 pages/roster 的成员详情一致（见 _load / onTogglePin / onNoteSave 等）。
 */
Component({
  options: { addGlobalClass: true, multipleSlots: true },

  properties: {
    show: {
      type: Boolean,
      value: false,
      observer(nv) { if (nv) this._load(); }
    },
    memberId: {
      type: Number,
      value: 0,
      observer(nv) { if (nv && this.properties.show) this._load(); }
    },
    classId: { type: Number, value: 0 }   // 0 = 本班
  },

  data: {
    mDetail: null,
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
      if (this.properties.show) this._load();
    }
  },

  methods: {
    /** 统一入参：带目标班级（0 = 本班），与 roster._payload 同口径 */
    _payload(extra) {
      return Object.assign({ classId: this.properties.classId }, extra || {});
    },

    /** 打开 / 换人时拉全量：成员详情 + 备注 + 固定态 */
    _load() {
      const memberId = Number(this.properties.memberId) || 0;
      if (!(memberId > 0)) return;
      const self = this;
      api.memberList(this._payload({ public: 'manage' }), { toast: false })
        .then((list) => {
          const hit = (list || []).find(x => Number(x.id) === memberId);
          if (hit == null) {
            util.toast('未找到该成员');
            self.setData({ mDetail: null });
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
          self._loadNotes(memberId);
          self._loadPinState(memberId);
        })
        .catch((e) => {
          console.error('[member-detail] 加载成员失败', e);
          util.toast('加载成员失败');
        });
    },

    _loadNotes(memberId) {
      api.noteList({ memberId }, { toast: false })
        .then((list) => {
          this.setData({
            noteList: (list || []).map(x => Object.assign({}, x, {
              createdAtText: String(x.createdAt || '').replace('T', ' ').slice(5, 16)
            }))
          });
        })
        .catch((e) => { console.error('[member-detail] 加载备注失败', e); });
    },

    _loadPinState(memberId) {
      api.pinList({}, { toast: false })
        .then((r) => {
          const list = (r && r.list) || [];
          this.setData({
            pinned: list.some(x => Number(x.memberId) === Number(memberId))
          });
        })
        .catch((e) => { console.error('[member-detail] 加载固定状态失败', e); });
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

    onToggleStatus() {
      const m = this.data.mDetail;
      if (m == null || this.data.mDetailIsSelf) return;
      const status = m.status === 'DISABLED' ? 'ACTIVE' : 'DISABLED';
      api.setMemberStatus(this._payload({ memberId: m.id, status }), { loading: '处理中' })
        .then(() => {
          util.toast(status === 'DISABLED' ? '已停用' : '已恢复');
          this.triggerEvent('changed');
          this.triggerEvent('close');
        })
        .catch((e) => {
          console.error('[member-detail] 启停失败', e);
          util.toast((e && e.errMsg) || '操作失败');
        });
    },

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
          this._loadNotes(m.id);
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
            if (m != null) this._loadNotes(m.id);
            this.triggerEvent('changed');
          })
          .catch((err) => util.toast((err && err.errMsg) || '删除失败'));
      });
    }
  }
});
