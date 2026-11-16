# 实现计划 · 课前演讲排班 v2（2026-11-17）

## v1 已完成（1.0.8.48）
- [x] T1 去光 / T2 值日卡去按压
- [x] 建表 speech / speech_cursor / speech_publish / speech_setting
- [x] schedule 新增 speech 路由族（generate/list/reassign/clear/publish/unpublish/settings）
- [x] speech-core 纯算法 + check-speech-schedule.js 门禁
- [x] 独立 pages/speech（v2 将删除）

## v2 待办
- [x] 0. grill-me 二次确认（4 轮弹窗）+ 规格更新（本文件）
- [ ] 1. **后端游标语义**：speech-core 起点改 A/B 双游标（撤销 start_weekday/start_slot/start_seq 消费）；generate 只写草稿不写 cursor；publish 落游标+存快照；unpublish 回滚快照；clear 不动 cursor。speech_setting 表增加/复用双游标字段或迁移。TDD 红线 + 变异自证。
- [ ] 2. **后端 AI 智能排班**：schedule 新增 speechAiParse（自然语言→指令，含组别校验红字）+ speechAiGenerate（按指令生成 preview rows，不落库）；用 resolveAiCfg/callAi。门禁+变异自证。
- [ ] 3. **前端值日页**：分段控件（值日|课前演讲，日期切换器不动）；按钮排随视图切换、历史并入最右、清空文案；周日默认下周。演讲视图整块从 pages/speech 搬入。
- [ ] 4. **前端演讲交互**：设置当前进度双游标、一键生成、智能排班输入+预览确认+红字错误、换人、清空、发布/撤回；api.js 补新接口；删 pages/speech 注册与跳转入口。
- [ ] 5. **数据库**：speech_setting 结构变更（起点字段）+ speech_publish 增游标快照列；生产库 ALTER + 复核。
- [ ] 6. **闭环发版 1.0.8.49**：全量门禁（worktree 基线对比零新增红）→ normalize-eol→wcsc→src-bytes→release-docs→commit/push→tag→publish-release→tcb 部署 schedule→真上传→HANDOFF/日志。

## 关键不变量（防漂移）
- 选修课不纳入；演讲人组 = 课次 group_tag；全体课取"本轮最小未排号"追平落后组
- **生成不落游标、发布才落、撤回回滚、清空不跳过** —— 这是 v2 最核心的游标契约
- 起点只有 A/B 两个"已排到号"，无其它固定设置；默认每场 2 人
- 智能排班：AI 只解析指令、内核执行排班；仅指定起始号时校验组别，不匹配红字报错；先预览确认
- 换人完全自由、不回退游标；草稿→发布才可见；权限 = 超管 OR 生活委员
- 日期切换器不动；分段控件切换值日/演讲；历史按钮在按钮排最右；周日默认下周
