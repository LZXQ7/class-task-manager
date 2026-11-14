/**
 * 姓名自动补全（v1.0.9.x · 2026-11-14 用户要求）
 * ================================================================
 * 「人名等选项多的字段用自动补全，输入时实时列出匹配项，并高亮匹配的文字。」
 *   ① 输入即**实时**过滤（不等失焦、不等回车）；
 *   ② 匹配项以**下拉列表**浮在输入框下方；
 *   ③ **命中的那段文字高亮**（姓名与学号都能命中）；
 *   ④ 点一项即选中（bind:pick，参数 { id }），失焦自动收起。
 *
 * 用法：
 *   <name-autocomplete items="{{cands}}" value="{{kw}}" placeholder="搜索姓名或学号"
 *                      bind:input="onKw" bind:pick="onPick" />
 *   items = [{ id, name, sub?, disabled? }]
 *
 * ⚠️ 组件自己不做业务过滤规则之外的事：名单从哪来、能不能选、选中后干什么，全归页面。
 */
Component({
  options: { addGlobalClass: true },
  properties: {
    /** 当前关键词（受控；页面也可以不绑） */
    value: {
      type: String, value: '',
      /* 受控用法：页面改了 value 也要重新过滤（否则外部赋值时下拉不更新）。
       * ⚠️ 空值 ⇒ 只清空、不展开下拉（页面初始化时 value='' 不该弹出一个空列表）。 */
      observer(v) { this._filter(v); }
    },
    /** 候选：[{ id, name, sub?, disabled? }] */
    items: { type: Array, value: () => [] },
    placeholder: { type: String, value: '搜索姓名或学号' },
    /** 最多显示多少条 */
    max: { type: Number, value: 8 },
    /** 空关键词时是否把全部候选列出来 */
    showAll: { type: Boolean, value: false },
    emptyText: { type: String, value: '没有匹配的同学' }
  },
  data: {
    list: [],      // 匹配结果（含高亮片段 parts）
    open: false    // 下拉是否展开
  },
  methods: {
    onInput(e) {
      const kw = String(e.detail.value || '');
      this.setData({ value: kw });
      this._filter(kw);
      this.triggerEvent('input', { value: kw });
    },
    onFocus() {
      this._filter(this.data.value);
    },
    onBlur() {
      // 延迟收起：让列表项的 tap 先于 blur 触发（否则点不到）
      const self = this;
      this._blurTimer = setTimeout(function () { self.setData({ open: false }); }, 140);
    },
    onClear() {
      this.setData({ value: '', list: [], open: false });
      this.triggerEvent('input', { value: '' });
    },
    onPick(e) {
      const id = e.currentTarget.dataset.id;
      this.setData({ open: false });
      this.triggerEvent('pick', { id });
    },
    /** 实时过滤 + 算高亮片段 */
    _filter(kw) {
      const items = this.properties.items || [];
      const q = String(kw || '').trim().toLowerCase();
      const max = this.properties.max || 8;
      let out = [];
      if (!q) {
        if (this.properties.showAll) {
          out = items.slice(0, max).map(i => this._decorate(i, ''));
        }
      } else {
        out = items
          .filter(i => this._hit(i, q))
          .slice(0, max)
          .map(i => this._decorate(i, q));
      }
      /* 空关键词 ⇒ 收起下拉（页面初始化 / 清空输入都走这里） */
      this.setData({ list: out, open: !!(out.length || this.properties.showAll) });
    },
    /** 姓名或附加信息（学号/备注）里包含关键词就算命中 */
    _hit(item, q) {
      const name = String(item.name || '').toLowerCase();
      const sub = String(item.sub || '').toLowerCase();
      return name.indexOf(q) >= 0 || sub.indexOf(q) >= 0;
    },
    /** 命中的那段切成高亮片段（姓名优先命中；姓名没命中就高亮 sub） */
    _decorate(item, q) {
      const o = Object.assign({}, item);
      const name = String(item.name || '');
      const sub = String(item.sub || '');
      if (!q) {
        o.parts = [{ t: name, hl: false }];
        o.subParts = [{ t: sub, hl: false }];
        return o;
      }
      const i = name.toLowerCase().indexOf(q);
      if (i >= 0) {
        o.parts = [
          { t: name.slice(0, i), hl: false },
          { t: name.slice(i, i + q.length), hl: true },
          { t: name.slice(i + q.length), hl: false }
        ].filter(p => p.t);
        o.subParts = [{ t: sub, hl: false }];
      } else {
        o.parts = [{ t: name, hl: false }];
        const j = sub.toLowerCase().indexOf(q);
        o.subParts = j >= 0 ? [
          { t: sub.slice(0, j), hl: false },
          { t: sub.slice(j, j + q.length), hl: true },
          { t: sub.slice(j + q.length), hl: false }
        ].filter(p => p.t) : [{ t: sub, hl: false }];
      }
      return o;
    }
  },
  detached() {
    if (this._blurTimer) { clearTimeout(this._blurTimer); this._blurTimer = null; }
  }
});
